import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

function setup(generateReply = async ({ chara }) => ({ text: `${chara.name}です` })) {
  const db = openDb(':memory:');
  const app = createApp({ db, generateReply, isProduction: false });
  // Cookie を保持する簡易クライアント
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
    };
    call.login = async (email) => {
      const { body } = await call('POST', '/auth/login', { email });
      const path = new URL(body.devLink).pathname + new URL(body.devLink).search;
      const r = await call('GET', path);
      assert.equal(r.status, 302);
    };
    return call;
  };
  return { db, client };
}

const CHARA = { name: 'ミナ', tagline: '図書館の司書', world_setting: '閉館後の図書館', profile: '20歳', opening: '*本を抱えて* こんばんは', tags: '日常', visibility: 'public' };

test('ログイン → キャラ作成 → 他ユーザが会話、無料枠を超えると402', async () => {
  const { client } = setup();
  const creator = client();
  await creator.login('creator@example.com');
  const me = await creator('GET', '/api/me');
  assert.equal(me.body.points.free, 50); // 登録ボーナス

  const created = await creator('POST', '/api/characters', CHARA);
  assert.equal(created.status, 201);
  const list = await creator('GET', '/api/characters');
  assert.equal(list.body.characters[0].name, 'ミナ');

  const reader = client();
  await reader.login('reader@example.com');
  const conv = await reader('POST', `/api/characters/${created.body.id}/conversations`);
  for (let i = 0; i < 10; i++) {
    const r = await reader('POST', `/api/conversations/${conv.body.id}/messages`, { content: `こんにちは${i}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.charged.via, 'quota');
  }
  // 11回目以降は登録ボーナスのポイントで払う
  const paid = await reader('POST', `/api/conversations/${conv.body.id}/messages`, { content: 'まだ話したい' });
  assert.equal(paid.body.charged.via, 'points');
  assert.equal(paid.body.points.free, 49);

  const history = await reader('GET', `/api/conversations/${conv.body.id}`);
  assert.equal(history.body.messages.length, 22);
  // 他人の会話は読めない
  assert.equal((await creator('GET', `/api/conversations/${conv.body.id}`)).status, 404);
});

test('ポイントも枠もなければ402', async () => {
  const { client, db } = setup();
  const u = client();
  await u.login('a@example.com');
  const { body } = await u('POST', '/api/characters', CHARA);
  const conv = await u('POST', `/api/characters/${body.id}/conversations`);
  db.exec(`UPDATE point_lots SET remaining = 0`);
  db.exec(`INSERT INTO usage_counters (user_id, feature, period_key, count) SELECT id, 'chat_message', 'day:' || date('now', '+9 hours'), 10 FROM users`);
  const r = await u('POST', `/api/conversations/${conv.body.id}/messages`, { content: 'hi' });
  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'payment_required');
});

test('生成に失敗したら枠が戻る', async () => {
  const { client } = setup(async () => { throw new Error('upstream down'); });
  const u = client();
  await u.login('a@example.com');
  const { body } = await u('POST', '/api/characters', CHARA);
  const conv = await u('POST', `/api/characters/${body.id}/conversations`);
  const r = await u('POST', `/api/conversations/${conv.body.id}/messages`, { content: 'hi' });
  assert.equal(r.status, 502);
  assert.equal((await u('GET', '/api/me')).body.usage.chat.used, 0);
});

test('非公開キャラは作成者以外から見えない・会話できない', async () => {
  const { client } = setup();
  const owner = client();
  await owner.login('owner@example.com');
  const { body } = await owner('POST', '/api/characters', { ...CHARA, visibility: 'private' });
  assert.equal((await owner('GET', `/api/characters/${body.id}`)).status, 200);
  const other = client();
  await other.login('other@example.com');
  assert.equal((await other('GET', `/api/characters/${body.id}`)).status, 404);
  assert.equal((await other('POST', `/api/characters/${body.id}/conversations`)).status, 404);
  assert.equal((await other('GET', '/api/characters')).body.characters.length, 0);
  // 他人のキャラは編集できない
  assert.equal((await other('PUT', `/api/characters/${body.id}`, CHARA)).status, 404);
});

test('ログインリンクは1回しか使えない', async () => {
  const { client } = setup();
  const u = client();
  const { body } = await u('POST', '/auth/login', { email: 'a@example.com' });
  const path = new URL(body.devLink).pathname + new URL(body.devLink).search;
  assert.equal((await u('GET', path)).status, 302);
  assert.equal((await client()('GET', path)).status, 400);
});
