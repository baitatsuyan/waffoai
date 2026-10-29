import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx, sqlTime } from '../src/db.js';
import { grantPoints, getBalance, spendPoints, InsufficientPointsError } from '../src/billing/points.js';
import { chargeFor, refundCharge, getUsage } from '../src/billing/plans.js';
import { getRewardSummary, requestPayout } from '../src/billing/rewards.js';
import { handleWaffoNotification } from '../src/billing/waffo.js';

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
  grantPoints(db, { userId: reader, kind: 'paid', amount: 100, source: 'waffo_purchase', sourceRef: 'pi_1' });
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
  grantPoints(db, { userId: reader, kind: 'paid', amount: 5, source: 'waffo_purchase', sourceRef: 'pi_1' });
  assert.throws(() => tx(db, () => spendPoints(db, { userId: reader, amount: 10, feature: 'x', now: NOW })), InsufficientPointsError);
  assert.equal(getBalance(db, reader, NOW).paid, 5);
});

test('同じ購入のポイントは二重付与されない', () => {
  const { db, reader } = setup();
  assert.equal(grantPoints(db, { userId: reader, kind: 'paid', amount: 300, source: 'waffo_purchase', sourceRef: 'pi_1' }), true);
  assert.equal(grantPoints(db, { userId: reader, kind: 'paid', amount: 300, source: 'waffo_purchase', sourceRef: 'pi_1' }), false);
  assert.equal(getBalance(db, reader).paid, 300);
});

test('無料プランは1日10回まで枠で会話し、超えたらポイント、なければ拒否', () => {
  const { db, reader, chara } = setup();
  for (let i = 0; i < 10; i++) {
    assert.equal(tx(db, () => chargeFor(db, { userId: reader, feature: 'chat_message', characterId: chara, now: NOW })).via, 'quota');
  }
  assert.throws(() => tx(db, () => chargeFor(db, { userId: reader, feature: 'chat_message', characterId: chara, now: NOW })), InsufficientPointsError);
  grantPoints(db, { userId: reader, kind: 'paid', amount: 2, source: 'waffo_purchase', sourceRef: 'pi_1' });
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
  grantPoints(db, { userId: reader, kind: 'paid', amount: 5, source: 'waffo_purchase', sourceRef: 'pi_1' });
  const receipt = tx(db, () => chargeFor(db, { userId: reader, feature: 'chat_message', characterId: chara, now: NOW }));
  assert.equal(getRewardSummary(db, creator, NOW).pending, 0.2);
  tx(db, () => refundCharge(db, receipt));
  assert.equal(getBalance(db, reader, NOW).paid, 5);
  assert.equal(getRewardSummary(db, creator, NOW).pending, 0);
});

test('クリエイター報酬は有償ポイントのみ対象、保留期間後に出金申請できる', () => {
  const { db, reader, creator, chara } = setup();
  grantPoints(db, { userId: reader, kind: 'free', amount: 100, source: 'bonus', sourceRef: 'b', expiresAt: new Date('2027-01-01') });
  grantPoints(db, { userId: reader, kind: 'paid', amount: 10000, source: 'waffo_purchase', sourceRef: 'pi_1' });
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
  grantPoints(db, { userId: creator, kind: 'paid', amount: 100, source: 'waffo_purchase', sourceRef: 'pi_c' });
  tx(db, () => chargeFor(db, { userId: creator, feature: 'image_generation', characterId: chara, now: NOW }));
  assert.equal(getRewardSummary(db, creator, NOW).pending, 0);
});

// ---- Waffo 通知 ----

function addPayment(db, userId, id, pack = 'p1000', amount = 1000, points = 1030) {
  db.prepare(`INSERT INTO payments (payment_request_id, user_id, pack, amount_jpy, points, status, acquiring_order_id) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, userId, pack, amount, points, `ACQ_${id}`);
}
const payment = (id, status, extra = {}) => ({
  eventType: 'PAYMENT_NOTIFICATION',
  result: { paymentRequestId: id, acquiringOrderId: `ACQ_${id}`, orderStatus: status, orderCurrency: 'JPY', orderAmount: '1000.00', ...extra },
});

test('Waffo: ポイント購入は PAY_SUCCESS で1回だけ付与、ORDER_CLOSE では付与しない', () => {
  const { db, reader } = setup();
  addPayment(db, reader, 'a');
  addPayment(db, reader, 'b');
  assert.equal(handleWaffoNotification(db, payment('a', 'PAY_IN_PROGRESS')), 'pending');
  assert.equal(getBalance(db, reader).paid, 0);
  assert.equal(handleWaffoNotification(db, payment('a', 'PAY_SUCCESS')), 'granted');
  handleWaffoNotification(db, payment('a', 'PAY_SUCCESS')); // 再送
  assert.equal(getBalance(db, reader).paid, 1030);
  assert.equal(handleWaffoNotification(db, payment('b', 'ORDER_CLOSE')), 'closed');
  assert.equal(getBalance(db, reader).paid, 1030);
  assert.equal(handleWaffoNotification(db, payment('zzz', 'PAY_SUCCESS')), 'unknown_payment');
});

test('Waffo: 金額が注文と違う通知はエラーにして付与しない（Waffo に再送させる）', () => {
  const { db, reader } = setup();
  addPayment(db, reader, 'a');
  assert.throws(() => handleWaffoNotification(db, payment('a', 'PAY_SUCCESS', { orderAmount: '10.00' })), /金額/);
  assert.throws(() => handleWaffoNotification(db, payment('a', 'PAY_SUCCESS', { orderCurrency: 'USD' })), /金額/);
  assert.equal(getBalance(db, reader).paid, 0);
});

test('Waffo: 返金は割合に応じて失効、同じ返金の再送は無視、チャージバックは残りを失効', () => {
  const { db, reader } = setup();
  addPayment(db, reader, 'a');
  handleWaffoNotification(db, payment('a', 'PAY_SUCCESS'));
  const refund = (id, status, amount) => ({ eventType: 'REFUND_NOTIFICATION', result: { refundRequestId: id, origPaymentRequestId: 'a', acquiringOrderId: 'ACQ_a', refundStatus: status, refundAmount: amount } });
  handleWaffoNotification(db, refund('r1', 'ORDER_PARTIALLY_REFUNDED', '500'));
  handleWaffoNotification(db, refund('r1', 'ORDER_PARTIALLY_REFUNDED', '500'));
  assert.equal(getBalance(db, reader).paid, 1030 - 515);
  handleWaffoNotification(db, { eventType: 'CHARGEBACK_NOTIFICATION', result: { chargebackId: 'cb1', originalOrderId: 'ACQ_a' } });
  assert.equal(getBalance(db, reader).paid, 0);
});

test('Waffo: 使用済みのポイントは返金で取り戻さない（残高はマイナスにならない）', () => {
  const { db, reader } = setup();
  addPayment(db, reader, 'a');
  handleWaffoNotification(db, payment('a', 'PAY_SUCCESS'));
  tx(db, () => spendPoints(db, { userId: reader, amount: 1000, feature: 'x', now: NOW }));
  handleWaffoNotification(db, { eventType: 'REFUND_NOTIFICATION', result: { refundRequestId: 'r1', origPaymentRequestId: 'a', refundStatus: 'ORDER_FULLY_REFUNDED', refundAmount: '1000' } });
  assert.equal(getBalance(db, reader).paid, 0);
});

function addSubscriptionRequest(db, userId, request, plan = 'plus', interval = 'month') {
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, interval, status, pending_request, pending_plan, pending_interval)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET pending_request = excluded.pending_request, pending_plan = excluded.pending_plan, pending_interval = excluded.pending_interval
  `).run(userId, plan, interval, request, plan, interval);
}
const periodPaid = (request, period, paidAt, amount = '980') => ({
  eventType: 'PAYMENT_NOTIFICATION',
  result: {
    paymentRequestId: `${request}_${period}`, orderStatus: 'PAY_SUCCESS', orderCurrency: 'JPY', orderAmount: amount, orderCompletedAt: paidAt,
    subscriptionInfo: { merchantRequest: request, subscriptionId: `SUB_${request}`, period: String(period), subscriptionEvent: 'PERIOD_CHARGE' },
  },
});

test('Waffo サブスク: 初回支払いでプラン有効化＋特典ポイント、更新で期間が延び、解約後も期間末まで使える', () => {
  const { db, reader } = setup();
  addSubscriptionRequest(db, reader, 'req1');
  assert.equal(getUsage(db, reader, NOW).plan, 'free'); // 支払い前は無料のまま

  // ステータス通知が先に届いても、支払い確認までは有効にしない
  handleWaffoNotification(db, { eventType: 'SUBSCRIPTION_STATUS_NOTIFICATION', result: { subscriptionRequest: 'req1', subscriptionStatus: 'ACTIVE', subscriptionId: 'SUB_req1' } });
  assert.equal(getUsage(db, reader, NOW).plan, 'free');

  handleWaffoNotification(db, periodPaid('req1', 1, '2026-10-29T02:00:00Z'));
  handleWaffoNotification(db, periodPaid('req1', 1, '2026-10-29T02:00:00Z')); // 再送
  assert.equal(getUsage(db, reader, NOW).plan, 'plus');
  assert.equal(getBalance(db, reader, NOW).free, 300);

  // 2期目（期間を延ばす）。そのあと1期目の通知が遅れて届いても巻き戻さない
  const nov = new Date('2026-11-29T05:00:00Z');
  handleWaffoNotification(db, periodPaid('req1', 2, '2026-11-29T02:00:00Z'));
  handleWaffoNotification(db, { eventType: 'SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION', result: {
    subscriptionRequest: 'req1', subscriptionId: 'SUB_req1', productInfo: { currentPeriod: '1' },
    paymentDetails: [{ period: '1', orderStatus: 'PAY_SUCCESS', orderUpdatedAt: '2026-10-29T02:00:00Z' }],
  } });
  assert.equal(getUsage(db, reader, nov).plan, 'plus');
  // 1期目の特典は1期目の終わりで失効し、2期目の分だけ残る
  assert.equal(getBalance(db, reader, nov).free, 300);

  handleWaffoNotification(db, { eventType: 'SUBSCRIPTION_STATUS_NOTIFICATION', result: { subscriptionRequest: 'req1', subscriptionStatus: 'USER_CANCELLED' } });
  assert.equal(getUsage(db, reader, nov).plan, 'plus');
  assert.equal(getUsage(db, reader, new Date('2027-01-01T00:00:00Z')).plan, 'free');
});

test('Waffo サブスク: 期間変更通知だけでも、支払い成功が確認できた期間を反映する', () => {
  const { db, reader } = setup();
  addSubscriptionRequest(db, reader, 'req1', 'pro', 'year');
  const r = (status) => ({ eventType: 'SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION', result: {
    subscriptionRequest: 'req1', subscriptionId: 'SUB1', productInfo: { currentPeriod: '1', nextPaymentDateTime: '2027-10-29T00:00:00Z' },
    paymentDetails: [{ period: '1', orderStatus: status, orderUpdatedAt: '2026-10-29T00:00:00Z' }],
  } });
  assert.equal(handleWaffoNotification(db, r('ORDER_CLOSE')), 'not_paid');
  assert.equal(getUsage(db, reader, NOW).plan, 'free');
  assert.equal(handleWaffoNotification(db, r('PAY_SUCCESS')), 'granted');
  assert.equal(getUsage(db, reader, new Date('2027-10-01T00:00:00Z')).plan, 'pro');
  assert.equal(getBalance(db, reader, NOW).free, 1500 * 12);
});

test('Waffo サブスク: 初回支払いが失敗（CLOSE）したら有効にならない。金額違いは拒否', () => {
  const { db, reader } = setup();
  addSubscriptionRequest(db, reader, 'req1');
  assert.throws(() => handleWaffoNotification(db, periodPaid('req1', 1, '2026-10-29T02:00:00Z', '1')), /金額/);
  handleWaffoNotification(db, { eventType: 'SUBSCRIPTION_STATUS_NOTIFICATION', result: { subscriptionRequest: 'req1', subscriptionStatus: 'CLOSE' } });
  assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(reader).status, 'closed');
  assert.equal(getUsage(db, reader, NOW).plan, 'free');
});

test('Waffo サブスク: 解約後に別プランで再加入すると、初回支払いで新しいプランに切り替わる', () => {
  const { db, reader } = setup();
  addSubscriptionRequest(db, reader, 'req1');
  handleWaffoNotification(db, periodPaid('req1', 1, '2026-10-29T02:00:00Z'));
  handleWaffoNotification(db, { eventType: 'SUBSCRIPTION_STATUS_NOTIFICATION', result: { subscriptionRequest: 'req1', subscriptionStatus: 'MERCHANT_CANCELLED' } });
  addSubscriptionRequest(db, reader, 'req2', 'premium', 'month');
  assert.equal(getUsage(db, reader, NOW).plan, 'plus'); // 支払いまでは旧プランのまま
  handleWaffoNotification(db, periodPaid('req2', 1, '2026-10-29T03:00:00Z', '1500'));
  const usage = getUsage(db, reader, NOW);
  assert.equal(usage.plan, 'premium');
  assert.equal(usage.chat.limit, 6000);
  assert.equal(db.prepare('SELECT status, subscription_id FROM subscriptions WHERE user_id = ?').get(reader).subscription_id, 'SUB_req2');
});
