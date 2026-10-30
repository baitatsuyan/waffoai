import { OFFICIAL, officialOwnerId } from '../seed.js';
import { buildInstructions } from '../prompt.js';
import { PERSONAS, VOICES } from '../personas.js';

// ログイン前のお試し（メインページのデモ会話・読み上げ、相棒づくりの「おまかせ」）。
// 会話は保存せず、道具も使わない。費用がかかるので、IP ごとと全体の1日の回数に上限を置く。

export const DEMO_LIMITS = { chat: 30, speech: 20, suggest: 10, total: 3000, turns: 8, chars: 300 };

// 日付が変わったら数え直す、プロセス内の簡単なカウンタ（サーバは1台構成）
export function dailyCounter(now = () => new Date()) {
  let day = '';
  let counts = new Map();
  return (key, max) => {
    const d = now().toISOString().slice(0, 10);
    if (d !== day) { day = d; counts = new Map(); }
    const n = (counts.get(key) ?? 0) + 1;
    if (n > max) return false;
    counts.set(key, n);
    return true;
  };
}

export const clientIp = (c) => c.req.header('cf-connecting-ip') || c.req.header('true-client-ip')
  || c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';

const DEMO_NOTE = '# お試し中\nこれはログイン前のお試し会話です。予定の登録や記録などの道具はまだ使えません。頼まれたら内容にはしっかり答えたうえで、「登録すると実際に記録して、当日にお知らせできる」と短く添える。返答は200字程度まで。';

// useScript：LLM が未設定のとき、会話は台本・おまかせはひな形で返す
export function demoRoutes(app, { db, generateReply, generateText, realtime, useScript, limits = DEMO_LIMITS, counter = dailyCounter() }) {
  const demoCharacters = () => {
    const owner = officialOwnerId(db);
    return OFFICIAL.filter((o) => o.demo).map((o) => {
      const c = db.prepare('SELECT id, name, persona, tagline, profile, opening, voice, voice_speed, image FROM characters WHERE creator_id = ? AND name = ?').get(owner ?? -1, o.name);
      return c && { ...c, prompts: o.demo.prompts };
    }).filter(Boolean);
  };

  // 1日の上限。IP ごとの上限に加えて、IP を偽って回されても全体で止まるようにする。
  const allow = (c, kind) => counter(`${kind}:${clientIp(c)}`, limits[kind]) && counter('total', limits.total);
  const limited = (c) => c.json({ error: 'お試しは今日はここまでです。無料登録すると続けて話せます', code: 'demo_limit' }, 429);

  app.get('/api/demo', (c) => c.json({ characters: demoCharacters(), voiceAvailable: Boolean(realtime) }));

  app.post('/api/demo/chat', async (c) => {
    const { characterId, history } = await c.req.json().catch(() => ({}));
    const chara = demoCharacters().find((x) => x.id === Number(characterId));
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    if (!Array.isArray(history) || !history.length) return c.json({ error: 'メッセージがありません' }, 400);
    const turns = history.slice(-DEMO_LIMITS.turns * 2).map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: String(m?.content ?? '').slice(0, limits.chars),
    })).filter((m) => m.content.trim());
    if (turns.at(-1)?.role !== 'user') return c.json({ error: 'メッセージがありません' }, 400);
    if (history.filter((m) => m?.role !== 'assistant').length > limits.turns) {
      return c.json({ error: 'お試しはここまでです。無料登録すると、続きから話せます', code: 'demo_turns' }, 429);
    }
    if (!allow(c, 'chat')) return limited(c);
    const text = useScript
      ? scriptedReply(chara, turns.at(-1).content)
      : (await generateReply({ instructions: `${buildInstructions(db, chara, { mode: 'text' })}\n\n${DEMO_NOTE}`, history: turns, opening: chara.opening })).text;
    return c.json({ text });
  });

  app.post('/api/demo/speech', async (c) => {
    if (!realtime) return c.json({ error: '音声は準備中です' }, 503);
    const { voice, speed, text } = await c.req.json().catch(() => ({}));
    if (!VOICES.includes(voice)) return c.json({ error: '声が正しくありません' }, 400);
    const sample = typeof text === 'string' && text.trim() ? text.trim().slice(0, 160) : 'こんにちは。今日はどんな一日でしたか？';
    if (!allow(c, 'speech')) return limited(c);
    try {
      const audio = await realtime.speech({ text: sample, voice, speed: Math.min(1.3, Math.max(0.7, Number(speed) || 1)) });
      return c.body(audio, 200, { 'Content-Type': 'audio/mpeg' });
    } catch {
      return c.json({ error: '音声を作れませんでした' }, 502);
    }
  });

  // 相棒づくりの「おまかせ」：役割・名前・キーワードから、性格の文章と最初のひとことを書く
  app.post('/api/make/suggest', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const persona = PERSONAS[body.persona] ? body.persona : 'chat';
    const name = String(body.name ?? '').trim().slice(0, 50) || '相棒';
    const traits = String(body.traits ?? '').trim().slice(0, 300);
    const role = String(body.role ?? '').trim().slice(0, 300);
    if (!allow(c, 'suggest')) return limited(c);
    if (useScript) return c.json(templateProfile({ persona, name, traits, role }));
    const text = await generateText({
      instructions: 'あなたは会話アプリのキャラクター設定を書くライターです。指定どおりの形式だけで答える。',
      prompt: `次の相棒の設定を日本語で書いてください。\n役割：${persona === 'other' ? role || '自由' : PERSONAS[persona].label}\n名前：${name}\nキーワード：${traits || '（おまかせ）'}\n\n形式：\nプロフィール：（年齢・一人称・話し方・性格・ユーザとの接し方を3〜4文で）\n最初のひとこと：（ユーザへの最初のあいさつを1〜2文で）`,
    });
    const profile = text.match(/プロフィール[：:]\s*([\s\S]*?)(?:\n\s*最初のひとこと|$)/)?.[1]?.trim();
    const opening = text.match(/最初のひとこと[：:]\s*([\s\S]*)$/)?.[1]?.trim();
    return c.json(profile ? { profile: profile.slice(0, 1000), opening: (opening ?? '').slice(0, 300) } : templateProfile({ persona, name, traits, role }));
  });
}

// LLM 未設定のときの台本。デモの見え方を確かめられるよう、よく押される質問には中身のある返事をする。
const SCRIPTS = {
  tutor: [
    [/簿記|資格|受か/, '1か月なら、ちゃんと間に合うよ。前半の2週間で仕訳と勘定科目を固めて、後半は過去問を毎日1回分。1日どれくらい時間を取れそうかな？ 教えてくれたら、日ごとの計画にしてみるね。'],
    [/続か|やる気|サボ/, '続かないのは、意志が弱いからじゃないよ。最初の一歩が重すぎるだけ。まずは「1日15分、問題を3問」から始めてみない？ 終わったら「やったよ」って一言送ってね。ちゃんと見てるから。'],
    [/減価償却/, 'ざっくり言うと「高い買い物の費用を、使う年数で分けて計上すること」だよ。100万円の車を5年使うなら、1年あたり20万円ずつ費用にするイメージ。じゃあ確認ね。30万円のパソコンを3年使うと、1年あたりいくら？'],
    [/10万|１０万|100,?000/, '正解！ すごい、ちゃんと分かってるね。次は「残存価額」がある場合をやってみよう。登録してくれたら、苦手なところを覚えておいて、次の問題で確かめるね。'],
  ],
  secretary: [
    [/予定|スケジュール/, 'かしこまりました。明日のご予定を、時間・場所・ご準備の順に整理いたします。ご予定をお聞かせいただけますか。ご登録いただければ、承った予定を当日の朝にまとめてお伝えし、30分前にもお声がけいたします。'],
    [/出張|旅行|段取り/, '承知いたしました。出張の段取りは、①移動と宿の確保 ②先方とのお約束の確定 ③資料とお持ち物の準備、の順に進めるのが確実でございます。行き先と日程をお教えいただければ、期限付きのタスクに分けてご用意いたします。'],
    [/多すぎ|忙し|終わらな/, 'ご安心ください。まずは思いつくままに、すべて私にお申し付けください。期限と重要度で並べ替え、今日なさるべき3つだけをお伝えいたします。残りは私がお預かりいたします。'],
  ],
};
const SCRIPT_FALLBACK = {
  tutor: 'うんうん。もう少し詳しく教えてくれる？ 目標の試験と、いつまでに受かりたいかが分かると、一緒に計画を立てられるよ。',
  secretary: 'かしこまりました。もう少し詳しくお聞かせいただけますか。日時や期限が分かれば、段取りまで整えてお伝えいたします。',
};
export function scriptedReply(chara, text) {
  const hit = (SCRIPTS[chara.persona] ?? []).find(([re]) => re.test(text));
  return hit?.[1] ?? SCRIPT_FALLBACK[chara.persona] ?? `${chara.name}です。もっとお話ししたいので、登録して続きを聞かせてください。`;
}

const OPENINGS = {
  chat: (n) => `${n}だよ。今日はどんな一日だった？ なんでも聞かせてね。`,
  trainer: (n) => `${n}だ。まずは目標と、週に何回動けるかを教えてくれ。一緒にメニューを組もう。`,
  tutor: (n) => `${n}です。いま取り組んでいる勉強と、試験の日を教えてね。一緒に計画を立てよう。`,
  secretary: (n) => `${n}でございます。ご予定やご用事は、お申し付けいただければ私が承ります。`,
  partner: (n) => `おかえり。${n}だよ。今日はどんな一日だった？`,
  language: () => "Hi! Let's chat in English. How was your day?",
  interpreter: (n) => `通訳の${n}です。話しかけていただければ、すぐに訳してお伝えします。`,
  other: (n) => `${n}です。どんなことから始めましょうか？`,
};
export function templateProfile({ persona, name, traits, role }) {
  const parts = [traits && `${traits}。`, persona === 'other' && role && `${role}を手伝う。`,
    'ユーザの話をよく覚えていて、次に話すときに自然に触れる。'].filter(Boolean);
  return { profile: parts.join('').replace(/。。/g, '。'), opening: OPENINGS[persona](name) };
}
