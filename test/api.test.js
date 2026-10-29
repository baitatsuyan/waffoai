import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';
import { Waffo, Environment } from '@waffo/waffo-node';
import { createMailer } from '../src/mail.js';

function setup(generateReply = async ({ instructions }) => ({ text: `${instructions.match(/「(.+?)」/)[1]}です` }), waffo = null) {
  const db = openDb(':memory:');
  const app = createApp({ db, waffo, generateReply, isProduction: false });
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
      return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
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

test('本番ではログインリンクをメールで送り、画面には出さない', async () => {
  const sent = [];
  const app = createApp({ db: openDb(':memory:'), isProduction: true, sendMail: async (m) => { sent.push(m); } });
  const post = (email) => app.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  const res = await post('a@example.com');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).devLink, undefined);
  assert.equal(sent[0].to, 'a@example.com');
  const link = sent[0].text.match(/https?:\/\/\S+/)[0];
  assert.equal((await app.request(new URL(link).pathname + new URL(link).search)).status, 302);

  // 送信に失敗したら 502、メール未設定の本番は受け付けない
  const failing = createApp({ db: openDb(':memory:'), isProduction: true, sendMail: async () => { throw new Error('down'); } });
  assert.equal((await failing.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"a@example.com"}' })).status, 502);
  const noMail = createApp({ db: openDb(':memory:'), isProduction: true, sendMail: null });
  assert.equal((await noMail.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"a@example.com"}' })).status, 503);
});

test('Resend へのリクエスト形式', async () => {
  const calls = [];
  const send = createMailer({ apiKey: 'k', from: 'AIボウ <no-reply@example.com>', fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('{}'); } });
  await send({ to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(calls[0].init.body).to, ['a@example.com']);
  assert.equal(createMailer({ apiKey: '', from: '' }), null);
});

test('ヘルスチェック', async () => {
  const app = createApp({ db: openDb(':memory:'), isProduction: false });
  const res = await app.request('/healthz');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

// ---- Waffo 決済 ----

function rsaPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: publicKey.toString('base64'), privateKey: privateKey.toString('base64') };
}
const derKey = (b64, type) => ({ key: Buffer.from(b64, 'base64'), format: 'der', type });

// 本物の SDK に、テスト用に生成した「Waffo 側」と「加盟店側」の鍵を持たせる
function realWaffo() {
  const waffoKeys = rsaPair();
  const merchantKeys = rsaPair();
  const waffo = new Waffo({ apiKey: 'test', privateKey: merchantKeys.privateKey, waffoPublicKey: waffoKeys.publicKey, merchantId: 'M1', environment: Environment.SANDBOX });
  const signAsWaffo = (body) => createSign('SHA256').update(body).sign(derKey(waffoKeys.privateKey, 'pkcs8'), 'base64');
  const verifyAsWaffo = (body, sig) => createVerify('SHA256').update(body).verify(derKey(merchantKeys.publicKey, 'spki'), sig, 'base64');
  return { waffo, signAsWaffo, verifyAsWaffo };
}

test('Waffo 未設定なら決済APIは503（カタログは見られる）', async () => {
  const { client } = setup();
  const u = client();
  await u.login('a@example.com');
  assert.equal((await u('POST', '/api/billing/checkout/points', { pack: 'p1000' })).status, 503);
  assert.equal((await u('GET', '/api/billing/catalog')).status, 200);
});

test('Waffo Webhook: 正しい署名なら付与して署名付き success、偽の署名なら failed で何もしない', async () => {
  const { waffo, signAsWaffo, verifyAsWaffo } = realWaffo();
  const { client, db } = setup(undefined, waffo);
  const u = client();
  await u.login('buyer@example.com');
  const userId = db.prepare('SELECT id FROM users').get().id;
  db.prepare(`INSERT INTO payments (payment_request_id, user_id, pack, amount_jpy, points, status) VALUES ('pr1', ?, 'p1000', 1000, 1030, 'pending')`).run(userId);

  const body = JSON.stringify({ eventType: 'PAYMENT_NOTIFICATION', result: { paymentRequestId: 'pr1', acquiringOrderId: 'ACQ1', orderStatus: 'PAY_SUCCESS', orderCurrency: 'JPY', orderAmount: '1000' } });
  const post = (signature) => app(db, waffo).request('/api/waffo/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SIGNATURE': signature }, body });

  const forged = await post(signAsWaffo(body + ' '));
  assert.equal(await forged.text(), '{"message":"failed"}');
  assert.equal((await u('GET', '/api/me')).body.points.paid, 0);

  const ok = await post(signAsWaffo(body));
  const okBody = await ok.text();
  assert.equal(ok.status, 200);
  assert.equal(okBody, '{"message":"success"}');
  assert.ok(verifyAsWaffo(okBody, ok.headers.get('x-signature')), '応答に加盟店の秘密鍵で署名している');
  assert.equal((await u('GET', '/api/me')).body.points.paid, 1030);
});

function app(db, waffo) {
  return createApp({ db, waffo, generateReply: async () => ({ text: '' }), isProduction: false });
}

function fakeWaffo(calls) {
  const ok = (data) => ({ isSuccess: () => true, getData: () => data, getCode: () => '0', getMessage: () => undefined });
  return {
    order: () => ({
      create: async (p) => { calls.push(['order.create', p]); return ok({ acquiringOrderId: 'ACQ9', orderStatus: 'PAY_IN_PROGRESS', orderAction: JSON.stringify({ webUrl: 'https://cashier.example/pay' }) }); },
      inquiry: async (p) => { calls.push(['order.inquiry', p]); return ok({ paymentRequestId: p.paymentRequestId, orderStatus: 'PAY_SUCCESS', orderCurrency: 'JPY', orderAmount: '1000' }); },
    }),
    subscription: () => ({
      create: async (p) => { calls.push(['subscription.create', p]); return ok({ subscriptionStatus: 'AUTHORIZATION_REQUIRED', subscriptionAction: JSON.stringify({ webUrl: 'https://cashier.example/sub' }) }); },
      cancel: async (p) => { calls.push(['subscription.cancel', p]); return ok({}); },
      manage: async (p) => { calls.push(['subscription.manage', p]); return ok({ managementUrl: 'https://cashier.example/manage' }); },
    }),
  };
}

test('Waffo: ポイント購入は JPY の注文を作って決済画面へ。戻ったら照会して付与', async () => {
  const calls = [];
  const { client } = setup(undefined, fakeWaffo(calls));
  const u = client();
  await u.login('buyer@example.com');
  const r = await u('POST', '/api/billing/checkout/points', { pack: 'p1000' });
  assert.equal(r.body.url, 'https://cashier.example/pay');
  const [, p] = calls[0];
  assert.equal(p.orderCurrency, 'JPY');
  assert.equal(p.orderAmount, '1000');
  assert.equal(p.paymentInfo.productName, 'ONE_TIME_PAYMENT');
  assert.equal(p.userInfo.userEmail, 'buyer@example.com');
  assert.ok(p.paymentRequestId.length <= 32);
  assert.match(p.notifyUrl, /\/api\/waffo\/webhook$/);

  const sync = await u('POST', `/api/billing/payments/${p.paymentRequestId}/sync`);
  assert.equal(sync.body.status, 'paid');
  assert.equal((await u('GET', '/api/me')).body.points.paid, 1030);
  // 他人の注文は照会できない
  const other = client();
  await other.login('other@example.com');
  assert.equal((await other('POST', `/api/billing/payments/${p.paymentRequestId}/sync`)).body.status, null);
});

test('Waffo: サブスク申し込み・二重加入の拒否・解約', async () => {
  const calls = [];
  const { client, db } = setup(undefined, fakeWaffo(calls));
  const u = client();
  await u.login('sub@example.com');
  const r = await u('POST', '/api/billing/checkout/subscription', { plan: 'plus', interval: 'year' });
  assert.equal(r.body.url, 'https://cashier.example/sub');
  const [, p] = calls[0];
  assert.deepEqual([p.currency, p.amount, p.productInfo.periodType, p.productInfo.periodInterval], ['JPY', '10000', 'MONTHLY', '12']);

  // 初回の支払いが確認できたら有効化（ここではDBを直接進める）
  db.prepare(`UPDATE subscriptions SET status = 'active', subscription_request = pending_request, subscription_id = 'SUB1', pending_request = NULL,
    current_period_start = datetime('now'), current_period_end = datetime('now', '+1 year')`).run();
  assert.equal((await u('POST', '/api/billing/checkout/subscription', { plan: 'pro', interval: 'month' })).status, 400);

  const cancel = await u('POST', '/api/billing/subscription/cancel');
  assert.equal(cancel.status, 200);
  assert.deepEqual(calls.at(-1)[1].subscriptionId, 'SUB1');
  const me = (await u('GET', '/api/me')).body;
  assert.equal(me.subscription.status, 'canceled');
  assert.equal(me.usage.plan, 'plus'); // 期間末までは使える
});
