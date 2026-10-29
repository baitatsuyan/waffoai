import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureOfficialCharacters, OFFICIAL_EMAIL } from '../src/seed.js';
import { executeTool } from '../src/tools.js';

function setup() {
  const db = openDb(':memory:');
  const officialIds = ensureOfficialCharacters(db);
  const app = createApp({ db, isProduction: false, generateReply: async () => ({ text: 'はい' }) });
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    call.login = async (email) => {
      const { body } = await call('POST', '/auth/login', { email });
      const u = new URL(body.devLink);
      await call('GET', u.pathname + u.search);
      return db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    };
    return call;
  };
  return { db, client, officialIds };
}

test('公式の相棒：起動のたびに呼んでも重複せず、さがすでは公式が先に並ぶ。公式アカウントではログインできない', async () => {
  const { db, client, officialIds } = setup();
  assert.deepEqual(ensureOfficialCharacters(db), officialIds);
  assert.equal(officialIds.length, 6);
  const u = client();
  await u.login('maker@example.com');
  await u('POST', '/api/characters', { name: 'タビ', visibility: 'public', persona: 'other', role: '旅行プランナー' });
  const list = (await u('GET', '/api/characters')).body.characters;
  assert.equal(list.at(-1).name, 'タビ');
  assert.ok(list.slice(0, 6).every((c) => c.official === 1));
  assert.equal((await u('POST', '/auth/login', { email: OFFICIAL_EMAIL })).status, 400);
});

test('はじめての人には公式の相棒をすすめ、相棒にすると一覧から外れる。外しても会話と記憶は残る', async () => {
  const { db, client, officialIds } = setup();
  const u = client();
  const userId = await u.login('a@example.com');
  let r = (await u('GET', '/api/companions')).body;
  assert.equal(r.companions.length, 0);
  assert.equal(r.suggested.length, 6);
  const [shion, kai] = officialIds;
  await u('POST', '/api/companions', { characterId: shion });
  await u('POST', '/api/companions', { characterId: kai });
  r = (await u('GET', '/api/companions')).body;
  assert.deepEqual(r.companions.map((c) => c.name).sort(), ['カイ', 'シオン']);
  assert.equal(r.suggested.length, 4);
  assert.equal((await u('GET', `/api/characters/${kai}`)).body.character.companion, true);

  executeTool(db, { userId, chara: db.prepare('SELECT * FROM characters WHERE id = ?').get(kai), name: 'remember', args: { kind: '目標', content: '週3回走る' } });
  await u('PUT', `/api/characters/${kai}/proactive`, { morning: { enabled: true, time: '07:00' } });
  await u('DELETE', `/api/companions/${kai}`);
  assert.equal((await u('GET', '/api/companions')).body.companions.length, 1);
  assert.equal((await u('GET', '/api/memories')).body.memories.length, 1);
  assert.equal((await u('GET', `/api/characters/${kai}/proactive`)).body.morning.enabled, false); // メッセージは止まる
});

test('話しかけたキャラは自動で相棒に加わり、最新の会話から続きを開ける', async () => {
  const { client, officialIds } = setup();
  const u = client();
  await u.login('a@example.com');
  const emma = officialIds[4];
  const first = (await u('POST', `/api/characters/${emma}/conversations/latest`)).body.id;
  await u('POST', `/api/conversations/${first}/messages`, { content: 'Hello!' });
  assert.equal((await u('POST', `/api/characters/${emma}/conversations/latest`)).body.id, first);
  const c = (await u('GET', '/api/companions')).body.companions[0];
  assert.deepEqual([c.name, c.last_message], ['Emma', 'はい']);
  // 恋人は年齢確認が必要
  assert.equal((await u('POST', `/api/characters/${officialIds[3]}/conversations/latest`)).body.code, 'age_required');
});

test('ホーム：相棒・今日と明日の予定・届いたメッセージをまとめて返す', async () => {
  const { db, client, officialIds } = setup();
  const u = client();
  const userId = await u.login('a@example.com');
  const shion = db.prepare('SELECT * FROM characters WHERE id = ?').get(officialIds[0]);
  await u('POST', '/api/companions', { characterId: shion.id });
  const tomorrow = new Date(Date.now() + 9 * 3600_000 + 86400_000).toISOString().slice(0, 10);
  executeTool(db, { userId, chara: shion, name: 'add_event', args: { date: tomorrow, time: '10:00', title: '歯医者' } });
  executeTool(db, { userId, chara: shion, name: 'add_event', args: { date: '2030-01-01', time: '10:00', title: '遠い予定' } });
  db.prepare(`INSERT INTO inbox (user_id, character_id, kind, text) VALUES (?, ?, 'morning', 'おはようございます')`).run(userId, shion.id);
  const home = (await u('GET', '/api/home')).body;
  assert.equal(home.companions[0].unread, 1);
  assert.deepEqual(home.upcoming.map((r) => r.data.title), ['歯医者']);
  assert.equal(home.inbox.unread, 1);
  assert.equal(home.inbox.latest[0].text, 'おはようございます');
});

test('作成者の調整（tweak）は作成者以外には見えない', async () => {
  const { client } = setup();
  const owner = client();
  await owner.login('owner@example.com');
  const id = (await owner('POST', '/api/characters', { name: 'カイ2', visibility: 'public', persona: 'trainer' })).body.id;
  await owner('PUT', `/api/characters/${id}/tweaks`, { scope: 'creator', text: '秘密の口調' });
  assert.equal((await owner('GET', `/api/characters/${id}`)).body.character.tweak, '秘密の口調');
  const other = client();
  await other.login('other@example.com');
  assert.equal((await other('GET', `/api/characters/${id}`)).body.character.tweak, undefined);
});
