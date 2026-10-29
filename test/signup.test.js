import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureOfficialCharacters, OFFICIAL_EMAIL } from '../src/seed.js';
import { buildInstructions } from '../src/prompt.js';
import { demoRoutes, dailyCounter } from '../src/routes/demo.js';

function setup(opts = {}) {
  const db = openDb(':memory:');
  ensureOfficialCharacters(db);
  const app = createApp({ db, isProduction: false, ...opts });
  const req = (method, path, body, headers = {}) => app.request(path, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { db, app, req };
}

const HARU = { persona: 'secretary', name: 'ハル', profile: '明るい。タメ口', world_setting: '', opening: 'おかえり！', voice: 'cedar', voice_speed: 1 };

test('登録前につくった相棒は、ログインリンクを開いたときに作られ、相棒に加わってマイページに案内される', async () => {
  const { db, req } = setup();
  const r = await req('POST', '/auth/login', { email: 'new@example.com', nickname: 'ゆう', character: HARU });
  assert.equal(r.status, 200);
  const link = new URL((await r.json()).devLink);
  const v = await req('GET', link.pathname + link.search);
  assert.equal(v.status, 302);
  const id = Number(v.headers.get('location').match(/welcome=(\d+)/)[1]);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get('new@example.com');
  const chara = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  assert.equal(chara.creator_id, user.id);
  assert.equal(chara.visibility, 'private');
  assert.equal(chara.name, 'ハル');
  assert.ok(db.prepare('SELECT 1 FROM user_companions WHERE user_id = ? AND character_id = ?').get(user.id, id));
  assert.equal(db.prepare(`SELECT text FROM inbox WHERE user_id = ? AND kind = 'welcome'`).get(user.id).text, 'おかえり！');
  assert.equal(user.nickname, 'ゆう');
  assert.match(buildInstructions(db, chara, { userId: user.id }), /「ゆう」と呼ばれたい/);
  // 同じリンクは2回使えない（相棒が2人できない）
  assert.equal((await req('GET', link.pathname + link.search)).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM characters WHERE creator_id = ?').get(user.id).n, 1);
});

test('登録時の入力チェック：名前のない相棒、18歳以上が対象の相棒、長すぎる呼び名', async () => {
  const { db, req } = setup();
  assert.equal((await req('POST', '/auth/login', { email: 'a@example.com', character: { ...HARU, name: '' } })).status, 400);
  const partner = { ...HARU, persona: 'partner' };
  assert.equal((await (await req('POST', '/auth/login', { email: 'a@example.com', character: partner })).json()).code, 'age_required');
  assert.equal((await (await req('POST', '/auth/login', { email: 'a@example.com', character: partner, birthDate: '2015-01-01' })).json()).code, 'age_restricted');
  assert.equal((await req('POST', '/auth/login', { email: 'a@example.com', nickname: 'あ'.repeat(21) })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM login_tokens').get().n, 0);

  const ok = await req('POST', '/auth/login', { email: 'a@example.com', character: partner, birthDate: '1995-04-01' });
  const link = new URL((await ok.json()).devLink);
  await req('GET', link.pathname + link.search);
  assert.equal(db.prepare('SELECT birth_date FROM users WHERE email = ?').get('a@example.com').birth_date, '1995-04-01');
});

test('公式の相棒の改名：以前の名前のキャラを同じ id のまま新しい設定にする', () => {
  const db = openDb(':memory:');
  const owner = Number(db.prepare(`INSERT INTO users (email, display_name) VALUES (?, 'AIボウ公式')`).run(OFFICIAL_EMAIL).lastInsertRowid);
  const old = Number(db.prepare(`INSERT INTO characters (creator_id, name, tagline, profile, opening, tags, visibility, persona, voice)
    VALUES (?, 'シオン', '', '', '', '', 'public', 'secretary', 'marin')`).run(owner).lastInsertRowid);
  const ids = ensureOfficialCharacters(db);
  assert.ok(ids.includes(old));
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(old);
  assert.equal(c.name, '黒崎');
  assert.equal(c.voice, 'cedar');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM characters').get().n, 6);
});

test('お試し：メインページの2人と台本の会話。ターン数の上限と読み上げ', async () => {
  const { req } = setup();
  const { characters, voiceAvailable } = await (await req('GET', '/api/demo')).json();
  assert.deepEqual(characters.map((c) => c.name), ['ミサキ', '黒崎']);
  assert.equal(characters[0].prompts.length, 3);
  assert.equal(voiceAvailable, false);
  const misaki = characters[0];
  const r = await (await req('POST', '/api/demo/chat', { characterId: misaki.id, history: [{ role: 'user', content: '簿記3級に1か月で受かりたい' }] })).json();
  assert.match(r.text, /1か月/);
  const long = Array.from({ length: 9 }, () => [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'はい' }]).flat().slice(0, -1);
  assert.equal((await (await req('POST', '/api/demo/chat', { characterId: misaki.id, history: long })).json()).code, 'demo_turns');
  // 公式のお試しキャラ以外とは話せない
  assert.equal((await req('POST', '/api/demo/chat', { characterId: 9999, history: [{ role: 'user', content: 'a' }] })).status, 404);
  assert.equal((await req('POST', '/api/demo/speech', { voice: 'marin', text: 'こんにちは' })).status, 503);
});

test('お試し：LLM があればキャラの設定とお試し中の注意を渡す', async () => {
  let seen;
  const { req } = setup({ generateReply: async (args) => { seen = args; return { text: 'ようこそ' }; } });
  const { characters } = await (await req('GET', '/api/demo')).json();
  const kurosaki = characters[1];
  const r = await (await req('POST', '/api/demo/chat', { characterId: kurosaki.id, history: [{ role: 'user', content: '明日の予定を整理して' }] })).json();
  assert.equal(r.text, 'ようこそ');
  assert.match(seen.instructions, /「黒崎」/);
  assert.match(seen.instructions, /お試し中/);
  assert.equal(seen.history.length, 1);
});

test('お試しの1日の上限（IP ごと・全体）', async () => {
  const db = openDb(':memory:');
  ensureOfficialCharacters(db);
  const app = new Hono();
  demoRoutes(app, { db, generateReply: null, generateText: null, realtime: null, useScript: true, limits: { chat: 2, speech: 1, suggest: 1, total: 3, turns: 8, chars: 300 }, counter: dailyCounter() });
  const id = (await (await app.request('/api/demo')).json()).characters[0].id;
  const chat = (ip) => app.request('/api/demo/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ characterId: id, history: [{ role: 'user', content: 'a' }] }) });
  assert.equal((await chat('1.1.1.1')).status, 200);
  assert.equal((await chat('1.1.1.1')).status, 200);
  assert.equal((await chat('1.1.1.1')).status, 429);
  assert.equal((await chat('2.2.2.2')).status, 200);
  assert.equal((await chat('3.3.3.3')).status, 429); // 全体の上限
});

test('相棒づくりの「おまかせ」：LLM がなければひな形で返す', async () => {
  const { req } = setup();
  const r = await (await req('POST', '/api/make/suggest', { persona: 'trainer', name: 'リュウ', traits: '明るい。タメ口' })).json();
  assert.match(r.profile, /明るい/);
  assert.match(r.opening, /リュウ/);
});
