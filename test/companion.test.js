import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { executeTool, ToolError, chatToolDefs, realtimeToolDefs } from '../src/tools.js';
import { buildInstructions, visibleMemories } from '../src/prompt.js';
import { runProactive } from '../src/proactive.js';
import { detectCrisis, ageGate, trackPartnerUsage } from '../src/safety.js';

function setup() {
  const db = openDb(':memory:');
  const user = Number(db.prepare(`INSERT INTO users (email, display_name) VALUES ('u@example.com', 'u')`).run().lastInsertRowid);
  const chara = (persona, name = persona, extra = {}) => {
    const id = Number(db.prepare(`INSERT INTO characters (creator_id, name, visibility, persona, profile, tweak) VALUES (?, ?, 'public', ?, ?, ?)`)
      .run(user, name, persona, extra.profile ?? '', extra.tweak ?? '').lastInsertRowid);
    return db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  };
  return { db, user, chara };
}

test('ツール: 役割ごとに使える道具が決まり、使えない道具は拒否する', () => {
  const { db, user, chara } = setup();
  const sec = chara('secretary');
  const mio = chara('partner');
  assert.deepEqual(chatToolDefs(sec).map((t) => t.function.name), ['remember', 'add_event', 'add_task', 'complete_task', 'get_records']);
  assert.equal(realtimeToolDefs(mio)[0].name, 'remember');
  assert.equal(realtimeToolDefs(chara('interpreter')).length, 0);
  assert.throws(() => executeTool(db, { userId: user, chara: mio, name: 'add_event', args: {} }), ToolError);
});

test('ツール: 予定の登録（日本時間）と重なりの検知、タスクの完了、記録の取得', () => {
  const { db, user, chara } = setup();
  const sec = chara('secretary');
  const run = (name, args) => executeTool(db, { userId: user, chara: sec, name, args });
  const a = run('add_event', { date: '2026-11-02', time: '10:00', title: '歯医者' });
  assert.equal(a.clash, null);
  assert.equal(db.prepare('SELECT due_at FROM records WHERE id = ?').get(a.id).due_at, '2026-11-02 01:00:00');
  assert.equal(run('add_event', JSON.stringify({ date: '2026-11-02', time: '10:30', title: '電話' })).clash, '歯医者');
  assert.throws(() => run('add_event', { date: '11/2', time: '10:00', title: 'x' }), /YYYY-MM-DD/);
  const t = run('add_task', { title: '見積書', due_date: '2026-11-06' });
  run('complete_task', { task_id: t.id });
  const tasks = run('get_records', { type: 'task' }).records;
  assert.equal(tasks[0].title, '見積書');
  assert.equal(tasks[0].done, true);
});

test('ツール: トレーニング記録は自己ベストを返し、単語カードと記憶は重複しない', () => {
  const { db, user, chara } = setup();
  const kai = chara('trainer');
  const run = (name, args, c = kai) => executeTool(db, { userId: user, chara: c, name, args });
  assert.deepEqual(run('log_workout', { exercises: [{ name: 'スクワット', weight_kg: 50, reps: 8 }] }).personal_bests, ['スクワット 50kg']);
  assert.deepEqual(run('log_workout', { exercises: [{ name: 'スクワット', weight_kg: 50, reps: 10 }] }).personal_bests, []);
  assert.deepEqual(run('log_workout', { exercises: [{ name: 'スクワット', weight_kg: 52.5, reps: 8 }] }).personal_bests, ['スクワット 52.5kg']);
  const emma = chara('language');
  run('add_flashcard', { front: 'I agree.', back: '賛成です' }, emma);
  assert.equal(run('add_flashcard', { front: 'I agree.', back: '賛成です' }, emma).note, 'すでにあります');
  run('remember', { kind: '好きなもの', content: '味噌ラーメン' });
  assert.equal(run('remember', { kind: '好きなもの', content: '味噌ラーメン' }).note, 'すでに覚えています');
});

test('記憶: 共有した記憶だけが他のキャラにも見える', () => {
  const { db, user, chara } = setup();
  const mio = chara('partner', 'ミオ');
  const sec = chara('secretary', 'シオン');
  executeTool(db, { userId: user, chara: mio, name: 'remember', args: { kind: '好きなもの', content: 'カレー' } });
  executeTool(db, { userId: user, chara: mio, name: 'remember', args: { kind: '記念日', content: '誕生日は3月3日', share: true } });
  assert.deepEqual(visibleMemories(db, user, mio.id).map((m) => m.content), ['カレー', '誕生日は3月3日']);
  assert.deepEqual(visibleMemories(db, user, sec.id).map((m) => m.content), ['誕生日は3月3日']);
});

test('指示文: 作成者の調整・本人の調整・記憶・グループ会話・音声向けの話し方が入る', () => {
  const { db, user, chara } = setup();
  const kai = chara('trainer', 'カイ', { profile: '体育会系', tweak: '語尾は「だぜ」' });
  const sec = chara('secretary', 'シオン');
  db.prepare(`INSERT INTO user_tweaks (character_id, user_id, text) VALUES (?, ?, '返答は短く')`).run(kai.id, user);
  executeTool(db, { userId: user, chara: kai, name: 'remember', args: { kind: '目標', content: '3か月で5kg減量' } });
  const text = buildInstructions(db, kai, { userId: user, members: [kai, sec], mode: 'voice', now: new Date('2026-10-29T03:00:00Z') });
  for (const part of ['「カイ」', 'パーソナルトレーナー', '体育会系', '語尾は「だぜ」', '返答は短く', '3か月で5kg減量', 'カイ、シオン', '音声で会話', '2026-10-29（木）12:00']) {
    assert.ok(text.includes(part), part);
  }
  // 試し話し用に本人の調整だけを差し替えられる
  assert.ok(buildInstructions(db, kai, { userId: user, tweakOverride: '関西弁' }).includes('関西弁'));
});

test('声かけ: 設定時刻を過ぎたら1日1回だけ届き、予定の30分前にリマインドする', async () => {
  const { db, user, chara } = setup();
  const sec = chara('secretary', 'シオン');
  db.prepare(`INSERT INTO proactive_settings (user_id, character_id, kind, time) VALUES (?, ?, 'morning', '07:30')`).run(user, sec.id);
  executeTool(db, { userId: user, chara: sec, name: 'add_event', args: { date: '2026-10-29', time: '09:00', title: 'チーム定例' } });
  const pushed = [];
  const generateText = async ({ instructions }) => (instructions.includes('チーム定例') ? 'おはようございます。9時から定例です。' : 'おはようございます。');
  const push = async (_db, uid, payload) => pushed.push([uid, payload.body]);

  assert.equal(await runProactive(db, { generateText, push, now: new Date('2026-10-28T22:00:00Z') }), 0); // 7:00 JST
  assert.equal(await runProactive(db, { generateText, push, now: new Date('2026-10-28T22:31:00Z') }), 1); // 7:31 JST
  assert.equal(await runProactive(db, { generateText, push, now: new Date('2026-10-28T22:40:00Z') }), 0); // 同じ日はもう送らない
  assert.equal(pushed[0][1], 'おはようございます。9時から定例です。');
  assert.equal(await runProactive(db, { generateText, push, now: new Date('2026-10-28T23:35:00Z') }), 1); // 8:35 JST → 9:00 の予定
  assert.equal(await runProactive(db, { generateText, push, now: new Date('2026-10-28T23:40:00Z') }), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 2);
});

test('声かけ: 生成に失敗したら、次の回に送り直す', async () => {
  const { db, user, chara } = setup();
  const mio = chara('partner', 'ミオ');
  db.prepare(`INSERT INTO proactive_settings (user_id, character_id, kind, time) VALUES (?, ?, 'night', '23:00')`).run(user, mio.id);
  const now = new Date('2026-10-29T14:10:00Z');
  await runProactive(db, { generateText: async () => { throw new Error('down'); }, push: async () => {}, now });
  assert.equal(await runProactive(db, { generateText: async () => 'おやすみ', push: async () => {}, now }), 1);
});

test('安全: 危機的な発言の検知、恋人ペルソナの年齢確認、長時間利用の声かけは1日1回', () => {
  const { db, user, chara } = setup();
  assert.equal(detectCrisis('もう消えたい'), true);
  assert.equal(detectCrisis('消しゴムを買いたい'), false);
  const mio = chara('partner', 'ミオ');
  const now = new Date('2026-10-29T03:00:00Z');
  assert.equal(ageGate({ birth_date: null }, mio, now).code, 'age_required');
  assert.equal(ageGate({ birth_date: '2010-01-01' }, mio, now).code, 'age_restricted');
  assert.equal(ageGate({ birth_date: '2008-10-29' }, mio, now), null); // 今日18歳
  assert.equal(ageGate({ birth_date: null }, chara('trainer'), now), null);
  assert.equal(trackPartnerUsage(db, { userId: user, chara: mio, minutes: 80, now }), null);
  assert.equal(trackPartnerUsage(db, { userId: user, chara: mio, minutes: 15, now }).kind, 'nudge');
  assert.equal(trackPartnerUsage(db, { userId: user, chara: mio, minutes: 15, now }), null);
});
