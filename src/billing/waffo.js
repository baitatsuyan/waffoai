import { randomBytes } from 'node:crypto';
import { Waffo, Environment } from '@waffo/waffo-node';
import { env, PLANS, POINT_PACKS } from '../config.js';
import { sqlTime, tx } from '../db.js';
import { grantPoints, revokePoints } from './points.js';

// Waffo の決済連携。
// - ポイント購入は単発決済（order/create）、プランは Waffo 管理のサブスク（subscription/create）
// - 決済結果は Webhook（notifyUrl）が正。リダイレクトだけでは付与しない
// - 通知は順不同・重複ありなので、付与・失効はすべて冪等にしている

export class WaffoApiError extends Error {}

export function isWaffoConfigured() {
  return Boolean(env.waffoApiKey && env.waffoPrivateKey && env.waffoPublicKey && env.waffoMerchantId);
}

export function createWaffoClient() {
  if (!isWaffoConfigured()) return null;
  return new Waffo({
    apiKey: env.waffoApiKey,
    privateKey: env.waffoPrivateKey,
    waffoPublicKey: env.waffoPublicKey,
    merchantId: env.waffoMerchantId,
    environment: env.waffoEnvironment === 'production' ? Environment.PRODUCTION : Environment.SANDBOX,
  });
}

// Waffo の冪等キー（最大32文字）
const requestId = () => randomBytes(16).toString('hex');
const notifyUrl = () => `${env.baseUrl}/api/waffo/webhook`;
// Waffo は userEmail 必須。ユーザごとに一意なメールを渡す。
const waffoUser = (user) => ({ userId: String(user.id), userEmail: user.email, userTerminal: 'WEB' });

// orderAction / subscriptionAction は JSON 文字列。中の webUrl に遷移させる。
function actionUrl(action) {
  if (!action) return null;
  try {
    return (typeof action === 'string' ? JSON.parse(action) : action).webUrl ?? null;
  } catch {
    return null;
  }
}

function unwrap(response) {
  if (!response.isSuccess()) throw new WaffoApiError(`Waffo API error ${response.getCode()}: ${response.getMessage() ?? ''}`);
  return response.getData();
}

export async function createPointCheckout(db, waffo, user, packId) {
  const pack = POINT_PACKS[packId];
  if (!pack) throw new Error('存在しないポイント商品です');
  const paymentRequestId = requestId();
  // 先に記録してから API を呼ぶ。応答が不明（タイムアウト等）でも後から照会できるようにするため。
  db.prepare(`INSERT INTO payments (payment_request_id, user_id, pack, amount_jpy, points, status) VALUES (?, ?, ?, ?, ?, 'pending')`)
    .run(paymentRequestId, user.id, packId, pack.priceJpy, pack.points);

  const data = unwrap(await waffo.order().create({
    paymentRequestId,
    merchantOrderId: `pt_${paymentRequestId}`,
    orderCurrency: 'JPY',
    orderAmount: String(pack.priceJpy),
    orderDescription: `${pack.points.toLocaleString()}pt`,
    notifyUrl: notifyUrl(),
    successRedirectUrl: `${env.baseUrl}/#/billing?status=success&payment=${paymentRequestId}`,
    failedRedirectUrl: `${env.baseUrl}/#/billing?status=failed`,
    cancelRedirectUrl: `${env.baseUrl}/#/billing?status=cancel`,
    userInfo: waffoUser(user),
    paymentInfo: { productName: 'ONE_TIME_PAYMENT' },
    goodsInfo: { goodsName: `${pack.points.toLocaleString()}pt`, goodsUrl: `${env.baseUrl}/#/billing` },
  }));
  db.prepare('UPDATE payments SET acquiring_order_id = ? WHERE payment_request_id = ?').run(data.acquiringOrderId ?? null, paymentRequestId);
  const url = actionUrl(data.orderAction);
  if (!url) throw new WaffoApiError('Waffo から決済画面の URL が返りませんでした');
  return url;
}

// サブスクの申し込み。支払いが確認できるまでは pending_* に置き、権利は付けない。
export async function createSubscriptionCheckout(db, waffo, user, plan, interval) {
  const amount = PLANS[plan]?.priceJpy?.[interval];
  if (!amount || plan === 'free') throw new Error('存在しないプランです');
  const current = db.prepare('SELECT status FROM subscriptions WHERE user_id = ?').get(user.id);
  if (current?.status === 'active') throw new Error('すでにプランに加入中です。プランを変える場合は、いまのプランを解約してから加入してください。');

  const subscriptionRequest = requestId();
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, interval, status, pending_request, pending_plan, pending_interval)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      pending_request = excluded.pending_request, pending_plan = excluded.pending_plan, pending_interval = excluded.pending_interval,
      status = CASE WHEN subscriptions.status = 'closed' THEN 'pending' ELSE subscriptions.status END
  `).run(user.id, plan, interval, subscriptionRequest, plan, interval);

  const data = unwrap(await waffo.subscription().create({
    subscriptionRequest,
    merchantSubscriptionId: `${plan}_${interval}`,
    currency: 'JPY',
    amount: String(amount),
    notifyUrl: notifyUrl(),
    productInfo: {
      description: `${PLANS[plan].name}プラン（${interval === 'year' ? '年額' : '月額'}）`,
      periodType: 'MONTHLY',
      periodInterval: interval === 'year' ? '12' : '1',
    },
    userInfo: waffoUser(user),
    paymentInfo: { productName: 'SUBSCRIPTION' },
    goodsInfo: { goodsId: `${plan}_${interval}`, goodsName: `${PLANS[plan].name}プラン` },
    successRedirectUrl: `${env.baseUrl}/#/billing?status=success`,
    failedRedirectUrl: `${env.baseUrl}/#/billing?status=failed`,
    cancelRedirectUrl: `${env.baseUrl}/#/billing?status=cancel`,
    // ログインが必要なページを指定する（Waffo の要件）
    subscriptionManagementUrl: `${env.baseUrl}/#/billing`,
    requestedAt: new Date().toISOString(),
  }));
  const url = actionUrl(data.subscriptionAction);
  if (!url) throw new WaffoApiError('Waffo から決済画面の URL が返りませんでした');
  return url;
}

// 解約。次回以降の請求が止まり、支払い済みの期間の終わりまではプランを使える。
export async function cancelSubscription(db, waffo, user) {
  const sub = db.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'`).get(user.id);
  if (!sub?.subscription_id) throw new Error('解約できるプランがありません');
  unwrap(await waffo.subscription().cancel({ subscriptionId: sub.subscription_id, requestedAt: new Date().toISOString() }));
  db.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE user_id = ?`).run(user.id);
  return { activeUntil: sub.current_period_end };
}

// 支払い方法の変更などは Waffo のサブスク管理ページに任せる。
export async function getManagementUrl(db, waffo, user) {
  const sub = db.prepare(`SELECT subscription_id FROM subscriptions WHERE user_id = ? AND status = 'active'`).get(user.id);
  if (!sub?.subscription_id) throw new Error('加入中のプランがありません');
  const data = unwrap(await waffo.subscription().manage({ subscriptionId: sub.subscription_id }));
  if (!data.managementUrl) throw new WaffoApiError('管理ページの URL が返りませんでした');
  return data.managementUrl;
}

// Webhook が遅れた・届かなかったときのための照会。決済画面から戻ったときに呼ぶ。
export async function syncPayment(db, waffo, user, paymentRequestId) {
  const payment = db.prepare('SELECT status FROM payments WHERE payment_request_id = ? AND user_id = ?').get(paymentRequestId, user.id);
  if (!payment) return null;
  if (payment.status === 'pending') {
    const data = unwrap(await waffo.order().inquiry({ paymentRequestId }));
    handleWaffoNotification(db, { eventType: 'PAYMENT_NOTIFICATION', result: data });
  }
  return db.prepare('SELECT status FROM payments WHERE payment_request_id = ?').get(paymentRequestId).status;
}

// Webhook の入口。署名を検証してから処理し、署名付きの応答（body と X-SIGNATURE）を返す。
// 処理に失敗したら failed を返し、Waffo に再送させる。
export function processWebhook(db, waffo, rawBody, signature) {
  const handler = waffo.webhook();
  let valid = false;
  try {
    valid = Boolean(signature) && handler.verifySignature(rawBody, signature);
  } catch {
    valid = false;
  }
  if (!valid) return handler.buildFailedResponse('invalid signature');
  try {
    handleWaffoNotification(db, JSON.parse(rawBody));
    return handler.buildSuccessResponse();
  } catch (err) {
    console.error('Waffo webhook handling failed:', err);
    return handler.buildFailedResponse(err.message);
  }
}

// 通知の処理本体（署名検証済みのもの）。SDK に依存しないのでテストから直接呼べる。
export function handleWaffoNotification(db, notification) {
  const r = notification.result ?? {};
  return tx(db, () => {
    switch (notification.eventType) {
      case 'PAYMENT_NOTIFICATION':
        return r.subscriptionInfo ? onSubscriptionPayment(db, r) : onPointPayment(db, r);
      case 'SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION':
        return onSubscriptionPeriodChanged(db, r);
      case 'SUBSCRIPTION_STATUS_NOTIFICATION':
        return onSubscriptionStatus(db, r);
      case 'REFUND_NOTIFICATION':
        return onRefund(db, r);
      case 'CHARGEBACK_NOTIFICATION':
        return onChargeback(db, r);
      default:
        return 'ignored';
    }
  });
}

const sameAmount = (a, b) => Number(a) === Number(b);

function onPointPayment(db, r) {
  // ユーザやポイント数は通知の中身ではなく、こちらで作った注文の記録から決める。
  const payment = db.prepare('SELECT * FROM payments WHERE payment_request_id = ?').get(r.paymentRequestId ?? '');
  if (!payment) return 'unknown_payment';
  if (r.orderStatus === 'ORDER_CLOSE') {
    db.prepare(`UPDATE payments SET status = 'closed' WHERE payment_request_id = ? AND status = 'pending'`).run(payment.payment_request_id);
    return 'closed';
  }
  if (r.orderStatus !== 'PAY_SUCCESS') return 'pending';
  if (r.orderCurrency !== 'JPY' || !sameAmount(r.orderAmount, payment.amount_jpy)) {
    throw new Error(`金額が一致しません: ${r.orderAmount} ${r.orderCurrency} / ${payment.amount_jpy} JPY`);
  }
  db.prepare(`UPDATE payments SET status = 'paid', acquiring_order_id = COALESCE(acquiring_order_id, ?) WHERE payment_request_id = ? AND status = 'pending'`)
    .run(r.acquiringOrderId ?? null, payment.payment_request_id);
  grantPoints(db, { userId: payment.user_id, kind: 'paid', amount: payment.points, source: 'waffo_purchase', sourceRef: payment.payment_request_id });
  return 'granted';
}

function findSubscription(db, request) {
  if (!request) return null;
  return db.prepare('SELECT * FROM subscriptions WHERE subscription_request = ? OR pending_request = ?').get(request, request) ?? null;
}

// 通知がいま有効なサブスクのものか、新しい申し込みのものかで、対象のプランが変わる。
function targetPlan(sub, request) {
  return sub.pending_request === request
    ? { plan: sub.pending_plan, interval: sub.pending_interval, isNew: true }
    : { plan: sub.plan, interval: sub.interval, isNew: false };
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

// 1期間分の支払い成功。期間を進め、特典ポイント（無償）を付ける。(申し込み, 期間番号) で冪等。
function grantPeriod(db, sub, request, { subscriptionId, period, paidAt, nextPaymentAt }) {
  const target = targetPlan(sub, request);
  const months = target.interval === 'year' ? 12 : 1;
  const periodNo = Number(period ?? 1);
  const start = paidAt ? new Date(paidAt) : new Date();
  const end = nextPaymentAt ? new Date(nextPaymentAt) : addMonths(start, months);

  if (target.isNew) {
    // 新しい申し込みの初回支払い：こちらを有効なサブスクに切り替える
    db.prepare(`
      UPDATE subscriptions SET status = 'active', plan = ?, interval = ?, subscription_request = ?, subscription_id = ?,
        pending_request = NULL, pending_plan = NULL, pending_interval = NULL,
        current_period_no = ?, current_period_start = ?, current_period_end = ?
      WHERE user_id = ?
    `).run(target.plan, target.interval, request, subscriptionId ?? null, periodNo, sqlTime(start), sqlTime(end), sub.user_id);
  } else {
    // 更新：古い期間の通知が後から届いても巻き戻さない
    db.prepare(`
      UPDATE subscriptions SET subscription_id = COALESCE(subscription_id, ?),
        status = CASE WHEN status = 'canceled' THEN 'canceled' ELSE 'active' END,
        current_period_no = ?, current_period_start = ?, current_period_end = ?
      WHERE user_id = ? AND (current_period_no IS NULL OR current_period_no < ?)
    `).run(subscriptionId ?? null, periodNo, sqlTime(start), sqlTime(end), sub.user_id, periodNo);
  }

  const bonus = PLANS[target.plan]?.monthlyPoints;
  if (bonus) {
    grantPoints(db, {
      userId: sub.user_id,
      kind: 'free',
      amount: bonus * months,
      source: 'subscription_bonus',
      sourceRef: `${request}:${periodNo}`,
      expiresAt: end,
    });
  }
}

function onSubscriptionPayment(db, r) {
  const info = r.subscriptionInfo;
  const request = info.merchantRequest ?? info.subscriptionRequest;
  const sub = findSubscription(db, request);
  if (!sub) return 'unknown_subscription';
  if (r.orderStatus !== 'PAY_SUCCESS') return 'pending';
  if (info.subscriptionEvent && info.subscriptionEvent !== 'PERIOD_CHARGE') return 'ignored';
  const target = targetPlan(sub, request);
  const expected = PLANS[target.plan]?.priceJpy?.[target.interval];
  if (r.orderCurrency !== 'JPY' || !sameAmount(r.orderAmount, expected)) {
    throw new Error(`サブスク金額が一致しません: ${r.orderAmount} ${r.orderCurrency} / ${expected} JPY`);
  }
  grantPeriod(db, sub, request, { subscriptionId: info.subscriptionId, period: info.period, paidAt: r.orderCompletedAt });
  return 'granted';
}

// 期間ごとの最終結果。支払い成功が確認できた期間だけ反映する（PAYMENT_NOTIFICATION と順不同で届く）。
function onSubscriptionPeriodChanged(db, r) {
  const sub = findSubscription(db, r.subscriptionRequest);
  if (!sub) return 'unknown_subscription';
  const period = r.productInfo?.currentPeriod;
  const paid = (r.paymentDetails ?? []).find((p) => String(p.period) === String(period) && p.orderStatus === 'PAY_SUCCESS');
  if (!paid) return 'not_paid';
  grantPeriod(db, sub, r.subscriptionRequest, {
    subscriptionId: r.subscriptionId,
    period,
    paidAt: paid.orderUpdatedAt,
    nextPaymentAt: r.productInfo?.nextPaymentDateTime,
  });
  return 'granted';
}

const CANCELLED = ['MERCHANT_CANCELLED', 'USER_CANCELLED', 'CHANNEL_CANCELLED', 'PLATFORM_CANCELLED', 'EXPIRED'];

function onSubscriptionStatus(db, r) {
  const sub = findSubscription(db, r.subscriptionRequest);
  if (!sub) return 'unknown_subscription';
  const isPending = sub.pending_request === r.subscriptionRequest;
  const s = r.subscriptionStatus;

  if (isPending) {
    // 新しい申し込みは、初回の支払い成功（grantPeriod）でだけ有効にする
    if (s === 'CLOSE' || CANCELLED.includes(s)) {
      db.prepare(`
        UPDATE subscriptions SET pending_request = NULL, pending_plan = NULL, pending_interval = NULL,
          status = CASE WHEN status = 'pending' THEN 'closed' ELSE status END
        WHERE user_id = ?
      `).run(sub.user_id);
      return 'closed';
    }
    return 'ignored';
  }
  if (s === 'ACTIVE') {
    db.prepare('UPDATE subscriptions SET subscription_id = COALESCE(subscription_id, ?) WHERE user_id = ?').run(r.subscriptionId ?? null, sub.user_id);
    return 'ok';
  }
  if (CANCELLED.includes(s)) {
    // 支払い済みの期間の終わりまでは使える（期限は current_period_end で判定）
    db.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE user_id = ?`).run(sub.user_id);
    return 'canceled';
  }
  return 'ignored';
}

function findPayment(db, paymentRequestId, acquiringOrderId) {
  return db.prepare('SELECT * FROM payments WHERE payment_request_id = ? OR acquiring_order_id = ?')
    .get(paymentRequestId ?? '', acquiringOrderId ?? '') ?? null;
}

// 返金：返金額の割合に応じて、その購入で付与した有償ポイントを失効させる（使用済みの分は戻せない）。
function onRefund(db, r) {
  if (!['ORDER_FULLY_REFUNDED', 'ORDER_PARTIALLY_REFUNDED'].includes(r.refundStatus)) return 'ignored';
  const payment = findPayment(db, r.origPaymentRequestId, r.acquiringOrderId);
  if (!payment) return 'unknown_payment';
  const points = r.refundStatus === 'ORDER_FULLY_REFUNDED'
    ? payment.points
    : Math.ceil((payment.points * Number(r.refundAmount)) / payment.amount_jpy);
  revokePoints(db, {
    source: 'waffo_purchase', sourceRef: payment.payment_request_id, amount: points,
    reason: `refund:${r.refundRequestId ?? r.acquiringRefundOrderId}`,
  });
  db.prepare(`UPDATE payments SET status = 'refunded' WHERE payment_request_id = ?`).run(payment.payment_request_id);
  return 'revoked';
}

// チャージバック：対象の購入で付与した有償ポイントをすべて失効させる。
function onChargeback(db, r) {
  const payment = findPayment(db, r.originalPaymentRequestId, r.originalOrderId);
  if (!payment) return 'unknown_payment';
  revokePoints(db, {
    source: 'waffo_purchase', sourceRef: payment.payment_request_id, amount: payment.points,
    reason: `chargeback:${payment.payment_request_id}`,
  });
  db.prepare(`UPDATE payments SET status = 'chargeback' WHERE payment_request_id = ?`).run(payment.payment_request_id);
  return 'revoked';
}
