import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx, sqlTime } from '../src/db.js';
import { grantPoints, getBalance, spendPoints, InsufficientPointsError } from '../src/billing/points.js';
import { chargeFor, refundCharge, getUsage } from '../src/billing/plans.js';
import { getRewardSummary, requestPayout } from '../src/billing/rewards.js';
import { handleStripeEvent } from '../src/billing/stripe.js';

function setup() {
  const db = openDb(':memory:');
  const user = (email) => Number(db.prepare('INSERT INTO users (email, display_name) VALUES (?, ?)').run(email, email).lastInsertRowid);
  const reader = user('reader@example.com');
  const creator = user('creator@example.com');
  const chara = Number(db.prepare(`INSERT INTO characters (creator_id, name, visibility) VALUES (?, 'テスト', 'public')`).run(creator).lastInsertRowid);
  return { db, reader, creator, chara };
}

const NOW = new Date('2026-10-29T03:00:00Z');

test('無償ポイントを有償ポイントより先に、期限の近い順に消費する', () => {
  const { db, reader } = setup();
  grantPoints(db, { userId: reader, kind: 'paid', amount: 100, source: 'stripe_purchase', sourceRef: 'pi_1' });
  grantPoints(db, { userId: reader, kind: 'free', amount: 5, source: 'bonus', sourceRef: 'late', expiresAt: new Date('2027-03-01') });
  grantPoints(db, { userId: reader, kind: 'free', amount: 3, source: 'bonus', sourceRef: 'soon', expiresAt: new Date('2026-11-01') });
  const spent = tx(db, () => spendPoints(db, { userId: reader, amount: 10, feature: 'image_generation', now: NOW }));
  assert.equal(spent.free, 8);
  assert.equal(spent.paid, 2);
  assert.deepEqual(getBalance(db, reader, NOW), { paid: 98, free: 0, total: 98 });
});

test('期限切れの無償ポイントは使えず、不足ならエラーで何も減らない', () => {
  const { db, reader } = setup();
  grantPoints(db, { userId: reader, kind: 'free', amount: 50, source: 'bonus', sourceRef: 'x', expiresAt: new Date('2026-10-01') });
  grantPoints(db, { userId: reader, kind: 'paid', amount: 5, source: 'stripe_purchase', sourceRef: 'pi_1' });
  assert.throws(() => tx(db, () => spendPoints(db, { userId: reader, amount: 10, feature: 'x', now: NOW })), InsufficientPointsError);
  assert.equal(getBalance(db, reader, NOW).paid, 5);
});

test('同じ購入のポイントは二重付与されない', () => {
  const { db, reader } = setup();
  assert.equal(grantPoints(db, { userId: reader, kind: 'paid', amount: 300, source: 'stripe_purchase', sourceRef: 'pi_1' }), true);
  assert.equal(grantPoints(db, { userId: reader, kind: 'paid', amount: 300, source: 'stripe_purchase', sourceRef: 'pi_1' }), false);
  assert.equal(getBalance(db, reader).paid, 300);
});

test('無料プランは1日10回まで枠で会話し、超えたらポイント、なければ拒否', () => {
  const { db, reader, chara } = setup();
  for (let i = 0; i < 10; i++) {
    assert.equal(tx(db, () => chargeFor(db, { userId: reader, feature: 'chat_message', characterId: chara, now: NOW })).via, 'quota');
  }
  assert.throws(() => tx(db, () => chargeFor(db, { userId: reader, feature: 'chat_message', characterId: chara, now: NOW })), InsufficientPointsError);
  grantPoints(db, { userId: reader, kind: 'paid', amount: 2, source: 'stripe_purchase', sourceRef: 'pi_1' });
  const r = tx(db, () => chargeFor(db, { userId: reader, feature: 'chat_message', characterId: chara, now: NOW }));
  assert.equal(r.via, 'points');
  assert.equal(getBalance(db, reader, NOW).paid, 1);
  // 翌日（日本時間）は枠が戻る
  const tomorrow = new Date('2026-10-29T15:30:00Z');
  assert.equal(getUsage(db, reader, tomorrow).chat.used, 0);
});

test('生成失敗時の取り消しで枠・ポイント・クリエイター報酬が元に戻る', () => {
  const { db, reader, creator, chara } = setup();
  db.prepare(`INSERT INTO usage_counters (user_id, feature, period_key, count) VALUES (?, 'chat_message', 'day:2026-10-29', 10)`).run(reader);
  grantPoints(db, { userId: reader, kind: 'paid', amount: 5, source: 'stripe_purchase', sourceRef: 'pi_1' });
  const receipt = tx(db, () => chargeFor(db, { userId: reader, feature: 'chat_message', characterId: chara, now: NOW }));
  assert.equal(getRewardSummary(db, creator, NOW).pending, 0.2);
  tx(db, () => refundCharge(db, receipt));
  assert.equal(getBalance(db, reader, NOW).paid, 5);
  assert.equal(getRewardSummary(db, creator, NOW).pending, 0);
});

test('クリエイター報酬は有償ポイントのみ対象、保留期間後に出金申請できる', () => {
  const { db, reader, creator, chara } = setup();
  grantPoints(db, { userId: reader, kind: 'free', amount: 100, source: 'bonus', sourceRef: 'b', expiresAt: new Date('2027-01-01') });
  grantPoints(db, { userId: reader, kind: 'paid', amount: 10000, source: 'stripe_purchase', sourceRef: 'pi_1' });
  tx(db, () => spendPoints(db, { userId: reader, amount: 100, feature: 'x', now: NOW })); // 無償だけ消費
  for (let i = 0; i < 250; i++) {
    tx(db, () => chargeFor(db, { userId: reader, feature: 'image_generation', characterId: chara, now: NOW }));
  }
  // 250回 × 20pt × 20% = 1000R
  assert.deepEqual(getRewardSummary(db, creator, NOW), { available: 0, pending: 1000, requestedOrPaid: 0, minPayoutR: 1000 });
  assert.throws(() => tx(db, () => requestPayout(db, creator, NOW)));
  const later = new Date(NOW.getTime() + 31 * 86400_000);
  assert.equal(tx(db, () => requestPayout(db, creator, later)).amountR, 1000);
  assert.equal(getRewardSummary(db, creator, later).requestedOrPaid, 1000);
});

test('自作キャラでの消費はクリエイター報酬にならない', () => {
  const { db, creator, chara } = setup();
  grantPoints(db, { userId: creator, kind: 'paid', amount: 100, source: 'stripe_purchase', sourceRef: 'pi_c' });
  tx(db, () => chargeFor(db, { userId: creator, feature: 'image_generation', characterId: chara, now: NOW }));
  assert.equal(getRewardSummary(db, creator, NOW).pending, 0);
});

test('Stripe: ポイント購入、コンビニ入金待ち、返金、重複イベント', () => {
  const { db, reader } = setup();
  const session = (id, status) => ({ id, mode: 'payment', payment_status: status, payment_intent: `pi_${id}`, metadata: { userId: String(reader), pack: 'p1000' } });
  assert.equal(handleStripeEvent(db, { id: 'evt_1', type: 'checkout.session.completed', data: { object: session('a', 'paid') } }), 'ok');
  assert.equal(handleStripeEvent(db, { id: 'evt_1', type: 'checkout.session.completed', data: { object: session('a', 'paid') } }), 'duplicate');
  assert.equal(getBalance(db, reader).paid, 1030);

  handleStripeEvent(db, { id: 'evt_2', type: 'checkout.session.completed', data: { object: session('b', 'unpaid') } });
  assert.equal(getBalance(db, reader).paid, 1030);
  handleStripeEvent(db, { id: 'evt_3', type: 'checkout.session.async_payment_succeeded', data: { object: session('b', 'paid') } });
  assert.equal(getBalance(db, reader).paid, 2060);

  handleStripeEvent(db, { id: 'evt_4', type: 'charge.refunded', data: { object: { payment_intent: 'pi_a' } } });
  assert.equal(getBalance(db, reader).paid, 1030);
});

test('Stripe: サブスク開始でプランが切り替わり、請求ごとに特典ポイントが付く', () => {
  const { db, reader } = setup();
  const start = Math.floor(NOW.getTime() / 1000) - 3600;
  const end = start + 30 * 86400;
  const meta = { userId: String(reader), plan: 'plus', interval: 'month' };
  handleStripeEvent(db, {
    id: 'evt_s1', type: 'customer.subscription.created',
    data: { object: { id: 'sub_1', status: 'active', metadata: meta, items: { data: [{ current_period_start: start, current_period_end: end }] } } },
  });
  const usage = getUsage(db, reader, NOW);
  assert.equal(usage.plan, 'plus');
  assert.equal(usage.chat.limit, 3000);

  handleStripeEvent(db, {
    id: 'evt_i1', type: 'invoice.paid',
    data: { object: { id: 'in_1', parent: { subscription_details: { metadata: meta } }, lines: { data: [{ period: { end } }] } } },
  });
  assert.equal(getBalance(db, reader, NOW).free, 300);

  handleStripeEvent(db, {
    id: 'evt_s2', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_1', status: 'canceled', metadata: meta, items: { data: [{ current_period_start: start, current_period_end: end }] } } },
  });
  assert.equal(getUsage(db, reader, NOW).plan, 'free');
  assert.ok(sqlTime(NOW));
});
