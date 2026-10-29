import { personaOf } from './personas.js';
import { sqlTime } from './db.js';

// キャラが会話の中で呼び出せる道具（ツール）。文字の会話（LLM の function calling）と
// 音声の会話（Realtime の function calling）で同じ定義・同じ処理を使う。
// 実行は必ずサーバ側で行い、ユーザ・キャラの組み合わせで権限を確かめる。

export class ToolError extends Error {}

const MEMORY_KINDS = ['好きなもの', '苦手なもの', '予定', '記念日', '目標', '体調', 'その他'];
const RECORD_TYPES = ['event', 'task', 'workout', 'quiz', 'flashcard'];

const str = (v, max, field) => {
  const s = String(v ?? '').trim();
  if (!s) throw new ToolError(`${field} が空です`);
  return s.slice(0, max);
};
const optNum = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// 日本時間の 'YYYY-MM-DD' と 'HH:MM' を UTC の SQL 時刻にする
function jstToSql(date, time = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError('date は YYYY-MM-DD 形式で指定してください');
  if (!/^\d{2}:\d{2}$/.test(time)) throw new ToolError('time は HH:MM 形式で指定してください');
  const d = new Date(`${date}T${time}:00+09:00`);
  if (Number.isNaN(d.getTime())) throw new ToolError('日時が正しくありません');
  return sqlTime(d);
}

function addRecord(db, ctx, type, data, dueAt = null) {
  const r = db.prepare('INSERT INTO records (user_id, character_id, type, data, due_at) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.userId, ctx.characterId, type, JSON.stringify(data), dueAt);
  return Number(r.lastInsertRowid);
}

export const TOOLS = {
  remember: {
    description: 'ユーザについて、今後の会話で役立つ大事なこと（好み・予定・記念日・目標など）を覚える。同じ内容を何度も覚えない。share=true にすると、ユーザの他のキャラも参照できる。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: MEMORY_KINDS },
        content: { type: 'string', description: '覚える内容。短い一文で。' },
        share: { type: 'boolean', description: '他のキャラとも共有してよい一般的な事実なら true' },
      },
      required: ['kind', 'content'],
    },
    run(db, ctx, args) {
      const kind = MEMORY_KINDS.includes(args.kind) ? args.kind : 'その他';
      const content = str(args.content, 200, 'content');
      const dup = db.prepare('SELECT id FROM memories WHERE user_id = ? AND character_id = ? AND content = ?').get(ctx.userId, ctx.characterId, content);
      if (dup) return { ok: true, id: dup.id, note: 'すでに覚えています' };
      const r = db.prepare('INSERT INTO memories (user_id, character_id, kind, content, scope) VALUES (?, ?, ?, ?, ?)')
        .run(ctx.userId, ctx.characterId, kind, content, args.share ? 'shared' : 'private');
      return { ok: true, id: Number(r.lastInsertRowid) };
    },
  },
  add_event: {
    description: '予定をカレンダーに登録する。日時は日本時間。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM（24時間表記）' },
        title: { type: 'string' },
      },
      required: ['date', 'time', 'title'],
    },
    run(db, ctx, args) {
      const title = str(args.title, 100, 'title');
      const at = jstToSql(String(args.date), String(args.time));
      const clash = db.prepare(`
        SELECT data, due_at FROM records WHERE user_id = ? AND type = 'event' AND done = 0
          AND abs(strftime('%s', due_at) - strftime('%s', ?)) < 3600
      `).get(ctx.userId, at);
      const id = addRecord(db, ctx, 'event', { title, date: args.date, time: args.time }, at);
      return { ok: true, id, clash: clash ? JSON.parse(clash.data).title : null };
    },
  },
  add_task: {
    description: 'タスク（やること）を登録する。期限があれば日本時間の日付で指定する。',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD（任意）' } },
      required: ['title'],
    },
    run(db, ctx, args) {
      const title = str(args.title, 100, 'title');
      const due = args.due_date ? jstToSql(String(args.due_date), '23:59') : null;
      return { ok: true, id: addRecord(db, ctx, 'task', { title, due_date: args.due_date ?? null }, due) };
    },
  },
  complete_task: {
    description: 'タスクを完了にする。task_id は get_records で確認する。',
    parameters: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'] },
    run(db, ctx, args) {
      const r = db.prepare(`UPDATE records SET done = 1 WHERE id = ? AND user_id = ? AND type = 'task'`).run(Number(args.task_id), ctx.userId);
      if (r.changes === 0) throw new ToolError('そのタスクは見つかりません');
      return { ok: true };
    },
  },
  log_workout: {
    description: '実施したトレーニングを記録する。',
    parameters: {
      type: 'object',
      properties: {
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, weight_kg: { type: 'number' }, reps: { type: 'integer' }, sets: { type: 'integer' } },
            required: ['name'],
          },
        },
        note: { type: 'string' },
      },
      required: ['exercises'],
    },
    run(db, ctx, args) {
      const exercises = (Array.isArray(args.exercises) ? args.exercises : []).slice(0, 20).map((e) => ({
        name: str(e?.name, 50, 'name'), weight_kg: optNum(e?.weight_kg), reps: optNum(e?.reps), sets: optNum(e?.sets),
      }));
      if (!exercises.length) throw new ToolError('種目がありません');
      // 前回より重い重量なら自己ベストとして返す（キャラが褒めるため）
      const prs = exercises.filter((e) => {
        if (e.weight_kg == null) return false;
        const best = db.prepare(`
          SELECT MAX(CAST(json_extract(x.value, '$.weight_kg') AS REAL)) AS w
          FROM records r, json_each(json_extract(r.data, '$.exercises')) x
          WHERE r.user_id = ? AND r.type = 'workout' AND json_extract(x.value, '$.name') = ?
        `).get(ctx.userId, e.name).w;
        return best == null || e.weight_kg > best;
      }).map((e) => `${e.name} ${e.weight_kg}kg`);
      const id = addRecord(db, ctx, 'workout', { exercises, note: args.note ? String(args.note).slice(0, 200) : '' });
      return { ok: true, id, personal_bests: prs };
    },
  },
  record_quiz: {
    description: '確認問題の結果を記録する。苦手分野の把握に使う。',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: '分野' }, question: { type: 'string' }, correct: { type: 'boolean' } },
      required: ['topic', 'correct'],
    },
    run(db, ctx, args) {
      const id = addRecord(db, ctx, 'quiz', { topic: str(args.topic, 50, 'topic'), question: String(args.question ?? '').slice(0, 200), correct: Boolean(args.correct) });
      const stats = db.prepare(`
        SELECT json_extract(data, '$.topic') AS topic, COUNT(*) AS n, SUM(json_extract(data, '$.correct')) AS ok
        FROM records WHERE user_id = ? AND character_id = ? AND type = 'quiz' GROUP BY topic
      `).all(ctx.userId, ctx.characterId);
      return { ok: true, id, accuracy_by_topic: stats.map((s) => ({ topic: s.topic, rate: Math.round((s.ok / s.n) * 100) })) };
    },
  },
  add_flashcard: {
    description: '覚えるべき英語表現を単語カードに追加する。',
    parameters: {
      type: 'object',
      properties: { front: { type: 'string', description: '英語' }, back: { type: 'string', description: '日本語の意味や解説' } },
      required: ['front', 'back'],
    },
    run(db, ctx, args) {
      const front = str(args.front, 200, 'front');
      const dup = db.prepare(`SELECT id FROM records WHERE user_id = ? AND type = 'flashcard' AND json_extract(data, '$.front') = ?`).get(ctx.userId, front);
      if (dup) return { ok: true, id: dup.id, note: 'すでにあります' };
      return { ok: true, id: addRecord(db, ctx, 'flashcard', { front, back: str(args.back, 300, 'back'), box: 0 }, sqlTime(new Date(Date.now() + 86400_000))) };
    },
  },
  get_records: {
    description: 'このユーザの記録（予定・タスク・トレーニング・小テスト・単語カード）を新しい順に取得する。',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', enum: RECORD_TYPES }, limit: { type: 'integer' } },
      required: ['type'],
    },
    run(db, ctx, args) {
      if (!RECORD_TYPES.includes(args.type)) throw new ToolError('type が正しくありません');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      const rows = db.prepare(`
        SELECT id, data, due_at, done, created_at FROM records WHERE user_id = ? AND type = ?
        ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, id DESC LIMIT ?
      `).all(ctx.userId, args.type, limit);
      return { ok: true, records: rows.map((r) => ({ id: r.id, ...JSON.parse(r.data), due_at_utc: r.due_at, done: Boolean(r.done) })) };
    },
  },
};

export function toolNamesFor(chara) {
  return personaOf(chara).tools.filter((n) => TOOLS[n]);
}

// OpenAI Chat Completions 形式
export function chatToolDefs(chara) {
  return toolNamesFor(chara).map((name) => ({ type: 'function', function: { name, description: TOOLS[name].description, parameters: TOOLS[name].parameters } }));
}

// Realtime セッション形式
export function realtimeToolDefs(chara) {
  return toolNamesFor(chara).map((name) => ({ type: 'function', name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }));
}

export function executeTool(db, { userId, chara, name, args }) {
  if (!toolNamesFor(chara).includes(name)) throw new ToolError(`このキャラは ${name} を使えません`);
  const parsed = typeof args === 'string' ? safeJson(args) : (args ?? {});
  return TOOLS[name].run(db, { userId, characterId: chara.id }, parsed);
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    throw new ToolError('引数が JSON ではありません');
  }
}
