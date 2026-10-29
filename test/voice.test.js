import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { grantPoints } from '../src/billing/points.js';
import { sweepVoiceSessions } from '../src/routes/voice.js';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';

function fakeRealtime() {
  const calls = [];
  let n = 0;
  return {
    calls,
    createCall: async ({ session }) => { calls.push(['create', session]); return { answer: 'v=0 answer', callId: `rtc_${++n}` }; },
    hangup: async (id) => { calls.push(['hangup', id]); return true; },
    createTranslationSecret: async ({ language }) => { calls.push(['translate', language]); return { value: 'ek_test', expiresAt: 0 }; },
    speech: async () => new Uint8Array([1, 2, 3]),
  };
}

function setup({ generateReply, generateText } = {}) {
  const db = openDb(':memory:');
  const realtime = fakeRealtime();
  const app = createApp({
    db, realtime, isProduction: false,
    generateReply: generateReply ?? (async () => ({ text: 'はい' })),
    generateText: generateText ?? (async ({ instructions }) => (instructions.includes('関西弁') ? 'まいど' : 'こんにちは')),
  });
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const type = res.headers.get('content-type') ?? '';
      return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
    };
    call.login = async (email) => {
      const { body } = await call('POST', '/auth/login', { email });
      const u = new URL(body.devLink);
      await call('GET', u.pathname + u.search);
      return db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    };
    return call;
  };
  return { db, realtime, client };
}

const mk = (u, body) => u('POST', '/api/characters', { visibility: 'public', ...body }).then((r) => r.body.id);
const ago = (db, sessionId, minutes) => db.prepare(`UPDATE voice_sessions SET started_at = datetime('now', ?) WHERE id = ?`).run(`-${minutes} minutes`, sessionId);

test('キャラ作成: 役割・声を保存。「その他」は役割の説明が必須、声は一覧から', async () => {
  const { client } = setup();
  const u = client();
  await u.login('a@example.com');
  assert.equal((await u('POST', '/api/characters', { name: 'タビ', visibility: 'public', persona: 'other' })).status, 400);
  const id = await mk(u, { name: 'タビ', persona: 'other', role: '旅行プランナー', voice: 'cedar', voice_speed: 1.1 });
  const c = (await u('GET', `/api/characters/${id}`)).body.character;
  assert.deepEqual([c.persona, c.role, c.voice, c.voice_speed], ['other', '旅行プランナー', 'cedar', 1.1]);
  assert.equal((await u('POST', '/api/characters', { name: 'x', visibility: 'public', voice: 'nova' })).status, 400);
  assert.equal((await u('POST', '/api/characters', { name: 'x', visibility: 'public', persona: 'wizard' })).status, 400);
});

test('文字チャット: キャラが道具（記憶）を使い、結果が会話とノートに残る。危機的な発言には相談窓口を返す', async () => {
  const generateReply = async ({ tools, runTool }) => {
    assert.ok(tools.some((t) => t.function.name === 'remember'));
    const r = runTool('remember', JSON.stringify({ kind: '好きなもの', content: 'カレー' }));
    const bad = runTool('add_event', '{}');
    return { text: 'カレー好きなんだね、覚えたよ', toolEvents: [{ name: 'remember', result: r }, { name: 'add_event', result: bad }] };
  };
  const { client } = setup({ generateReply });
  const u = client();
  await u.login('a@example.com');
  const id = await mk(u, { name: 'ハル', persona: 'chat' });
  const conv = (await u('POST', `/api/characters/${id}/conversations`)).body.id;
  const r = await u('POST', `/api/conversations/${conv}/messages`, { content: 'カレーが好き。でも最近ちょっと消えたい' });
  assert.deepEqual(r.body.toolEvents, [{ name: 'remember', ok: true }, { name: 'add_event', ok: false }]);
  assert.equal(r.body.notices[0].kind, 'crisis');
  assert.ok(r.body.notices[0].resources.length >= 3);
  assert.equal((await u('GET', '/api/memories')).body.memories[0].content, 'カレー');
});

test('恋人ペルソナは生年月日の登録が必要で、18歳未満は使えない', async () => {
  const { client } = setup();
  const u = client();
  await u.login('a@example.com');
  const mio = await mk(u, { name: 'ミオ', persona: 'partner' });
  assert.equal((await u('POST', `/api/characters/${mio}/conversations`)).body.code, 'age_required');
  assert.equal((await u('POST', '/api/me/birth-date', { birthDate: '2015-04-01' })).status, 200);
  assert.equal((await u('POST', `/api/characters/${mio}/conversations`)).body.code, 'age_restricted');
  await u('POST', '/api/me/birth-date', { birthDate: '1995-04-01' });
  assert.equal((await u('POST', `/api/characters/${mio}/conversations`)).status, 201);
  assert.equal((await u('POST', '/api/voice/sessions', { mode: 'direct', characterIds: [mio] })).status, 201);
});

test('調整: 作成者の公開調整と本人用の調整、版の保存と戻し、調整前後の比較', async () => {
  const { client } = setup();
  const owner = client();
  await owner.login('owner@example.com');
  const id = await mk(owner, { name: 'カイ', persona: 'trainer' });
  await owner('PUT', `/api/characters/${id}/tweaks`, { scope: 'creator', text: 'もっと褒める' });
  await owner('PUT', `/api/characters/${id}/tweaks`, { scope: 'creator', text: '厳しめに' });
  let t = (await owner('GET', `/api/characters/${id}/tweaks`)).body;
  assert.equal(t.creator, '厳しめに');
  const prev = t.versions.find((v) => v.text === 'もっと褒める');
  await owner('POST', `/api/characters/${id}/tweaks/revert`, { versionId: prev.id });
  t = (await owner('GET', `/api/characters/${id}/tweaks`)).body;
  assert.equal(t.creator, 'もっと褒める');
  assert.ok(t.versions.some((v) => v.text === '厳しめに')); // 戻す前の内容も残る

  const fan = client();
  await fan.login('fan@example.com');
  assert.equal((await fan('PUT', `/api/characters/${id}/tweaks`, { scope: 'creator', text: '乗っ取り' })).status, 403);
  await fan('PUT', `/api/characters/${id}/tweaks`, { scope: 'personal', text: '関西弁で' });
  const ft = (await fan('GET', `/api/characters/${id}/tweaks`)).body;
  assert.deepEqual([ft.isCreator, ft.personal], [false, '関西弁で']);
  assert.equal(ft.versions.filter((v) => v.scope === 'creator').length, 0); // 作成者の履歴は見えない
  // 比較：いまの調整での返答と、新しい調整での返答を並べる（2回分の会話として課金）
  const cmp = await owner('POST', `/api/characters/${id}/tweaks/compare`, { text: '関西弁で話す' });
  assert.deepEqual(cmp.body, { before: 'こんにちは', after: 'まいど' });
  assert.equal((await owner('GET', '/api/me')).body.usage.chat.used, 2);
});

test('音声1対1: 開始で1分課金、キャラの指示文・声・道具を付けて接続し、経過分をハートビートで請求', async () => {
  const { client, db, realtime } = setup();
  const u = client();
  await u.login('a@example.com');
  const kai = await mk(u, { name: 'カイ', persona: 'trainer', voice: 'cedar' });
  const s = (await u('POST', '/api/voice/sessions', { mode: 'direct', characterIds: [kai] })).body;
  assert.equal(s.notice, 'AIが生成した音声です。');
  const conn = await u('POST', `/api/voice/sessions/${s.sessionId}/connect`, { role: 'direct', sdp: SDP });
  assert.equal(conn.status, 201);
  assert.equal(conn.body, 'v=0 answer');
  const session = realtime.calls[0][1];
  assert.equal(session.audio.output.voice, 'cedar');
  assert.equal(session.audio.input.turn_detection.type, 'semantic_vad');
  assert.ok(session.instructions.includes('「カイ」') && session.instructions.includes('音声で会話'));
  assert.ok(session.tools.some((t) => t.name === 'log_workout'));
  assert.equal((await u('GET', '/api/me')).body.usage.voiceMinutes.used, 1);

  ago(db, s.sessionId, 2.5);
  const hb = (await u('POST', `/api/voice/sessions/${s.sessionId}/heartbeat`)).body;
  assert.deepEqual([hb.ended, hb.minutes, hb.usage.used], [false, 3, 3]); // 無料枠3分を使い切る
  // 道具と文字起こし
  const tool = await u('POST', `/api/voice/sessions/${s.sessionId}/tool`, { characterId: kai, name: 'log_workout', arguments: '{"exercises":[{"name":"腕立て","reps":20}]}' });
  assert.equal(tool.body.ok, true);
  await u('POST', `/api/voice/sessions/${s.sessionId}/transcript`, { role: 'user', text: '腕立て20回やった' });
  await u('POST', `/api/voice/sessions/${s.sessionId}/transcript`, { role: 'assistant', characterId: kai, text: 'ナイス！記録したぞ' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);

  // 枠もポイントもない状態で1分たつと、サーバが通話を切る
  db.exec('UPDATE point_lots SET remaining = 0');
  ago(db, s.sessionId, 3.5);
  const end = (await u('POST', `/api/voice/sessions/${s.sessionId}/heartbeat`)).body;
  assert.deepEqual(end, { ended: true, reason: 'payment_required' });
  assert.deepEqual(realtime.calls.at(-1), ['hangup', 'rtc_1']);
  assert.equal((await u('POST', `/api/voice/sessions/${s.sessionId}/connect`, { role: 'direct', sdp: SDP })).status, 410);
});

test('音声グループ: 参加キャラ数ぶん課金し、耳1本＋キャラごとの声で接続。上限4人', async () => {
  const { client, db, realtime } = setup();
  const u = client();
  const userId = await u.login('a@example.com');
  grantPoints(db, { userId, kind: 'paid', amount: 100, source: 'test', sourceRef: '1' });
  const a = await mk(u, { name: 'シオン', persona: 'secretary' });
  const b = await mk(u, { name: 'カイ', persona: 'trainer', voice: 'ash' });
  const s = (await u('POST', '/api/voice/sessions', { mode: 'group', characterIds: [a, b] })).body;
  assert.equal((await u('GET', '/api/me')).body.usage.voiceMinutes.used, 2);
  await u('POST', `/api/voice/sessions/${s.sessionId}/connect`, { role: 'ear', sdp: SDP });
  await u('POST', `/api/voice/sessions/${s.sessionId}/connect`, { role: 'voice', characterId: b, sdp: SDP });
  assert.equal((await u('POST', `/api/voice/sessions/${s.sessionId}/connect`, { role: 'voice', characterId: 999, sdp: SDP })).status, 400);
  const [ear, voice] = realtime.calls.map((x) => x[1]);
  assert.equal(ear.audio.input.turn_detection.create_response, false);
  assert.deepEqual(ear.output_modalities, ['text']);
  assert.equal(voice.audio.output.voice, 'ash');
  assert.equal(voice.audio.input.turn_detection, null);
  assert.ok(voice.instructions.includes('シオン、カイ'));

  ago(db, s.sessionId, 1.5);
  await u('POST', `/api/voice/sessions/${s.sessionId}/heartbeat`);
  // 2分目×2人：1人分は無料枠の残り（3分目）、もう1人分は 10pt（登録ボーナスの無償ポイントから先に使う）
  const me = (await u('GET', '/api/me')).body;
  assert.equal(me.usage.voiceMinutes.used, 3);
  assert.deepEqual([me.points.free, me.points.paid], [40, 100]);
  assert.equal((await u('POST', '/api/voice/sessions', { mode: 'group', characterIds: [1, 2, 3, 4, 5] })).status, 400);
});

test('音声: 通訳は通訳キャラだけ、翻訳用の短命キーを発行。ハートビートが途切れたら切る', async () => {
  const { client, db, realtime } = setup();
  const u = client();
  await u.login('a@example.com');
  const rin = await mk(u, { name: 'リン', persona: 'interpreter' });
  const kai = await mk(u, { name: 'カイ', persona: 'trainer' });
  assert.equal((await u('POST', '/api/voice/sessions', { mode: 'interpret', characterIds: [kai] })).status, 400);
  assert.equal((await u('POST', '/api/voice/sessions', { mode: 'direct', characterIds: [rin] })).status, 400);
  const s = (await u('POST', '/api/voice/sessions', { mode: 'interpret', characterIds: [rin] })).body;
  assert.match(s.notice, /機械による通訳/);
  assert.equal((await u('POST', `/api/voice/sessions/${s.sessionId}/translation`, { language: 'klingon' })).status, 400);
  assert.equal((await u('POST', `/api/voice/sessions/${s.sessionId}/translation`, { language: 'en' })).body.value, 'ek_test');

  const d = (await u('POST', '/api/voice/sessions', { mode: 'direct', characterIds: [kai] })).body;
  assert.equal(db.prepare('SELECT end_reason FROM voice_sessions WHERE id = ?').get(s.sessionId).end_reason, 'replaced'); // 前のセッションは閉じる
  await u('POST', `/api/voice/sessions/${d.sessionId}/connect`, { role: 'direct', sdp: SDP });
  db.prepare(`UPDATE voice_sessions SET last_heartbeat_at = datetime('now', '-5 minutes') WHERE id = ?`).run(d.sessionId);
  assert.equal(await sweepVoiceSessions(db, realtime), 1);
  assert.deepEqual(realtime.calls.at(-1), ['hangup', 'rtc_1']);
});

test('音声: OPENAI_API_KEY がなければ 503、声のお試しは mp3 を返す', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db, realtime: null, isProduction: false });
  assert.equal((await app.request('/api/voice/sessions', { method: 'POST' })).status, 503);

  const { client } = setup();
  const u = client();
  await u.login('a@example.com');
  const r = await u('POST', '/api/voice/preview', { voice: 'marin' });
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await u('POST', '/api/voice/preview', { voice: 'nova' })).status, 400);
});
