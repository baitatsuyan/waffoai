import Stripe from 'stripe';
import { env, PLANS, POINT_PACKS } from '../config.js';
import { sqlTime, tx } from '../db.js';
import { grantPoints, revokeLot } from './points.js';

let client;
export function stripeClient() {
  if (!env.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY が未設定です');
  client ??= new Stripe(env.stripeSecretKey);
  return client;
}

async function ensureCustomer(db, user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripeClient().customers.create({ email: user.email, metadata: { userId: String(user.id) } });
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer.id, user.id);
  return customer.id;
}

export async function createSubscriptionCheckout(db, user, plan, interval) {
  const amount = PLANS[plan]?.priceJpy?.[interval];
  if (!amount) throw new Error('存在しないプランです');
  const metadata = { userId: String(user.id), plan, interval };
  const session = await stripeClient().checkout.sessions.create({
    mode: 'subscription',
    customer: await ensureCustomer(db, user),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'jpy',
        unit_amount: amount,
        recurring: { interval },
        product_data: { name: `${PLANS[plan].name}プラン（${interval === 'year' ? '年額' : '月額'}）` },
      },
    }],
    metadata,
    subscription_data: { metadata },
    success_url: `${env.baseUrl}/#/billing?status=success`,
    cancel_url: `${env.baseUrl}/#/billing?status=cancel`,
  });
  return session.url;
}

export async function createPointCheckout(db, user, packId) {
  const pack = POINT_PACKS[packId];
  if (!pack) throw new Error('存在しないポイント商品です');
  const session = await stripeClient().checkout.sessions.create({
    mode: 'payment',
    customer: await ensureCustomer(db, user),
    line_items: [{
      quantity: 1,
      price_data: { currency: 'jpy', unit_amount: pack.priceJpy, product_data: { name: `${pack.points.toLocaleString()}pt` } },
    }],
    metadata: { userId: String(user.id), pack: packId },
    success_url: `${env.baseUrl}/#/billing?status=success`,
    cancel_url: `${env.baseUrl}/#/billing?status=cancel`,
  });
  return session.url;
}

export async function createPortalSession(db, user) {
  const session = await stripeClient().billingPortal.sessions.create({
    customer: await ensureCustomer(db, user),
    return_url: `${env.baseUrl}/#/billing`,
  });
  return session.url;
}

export function verifyWebhook(rawBody, signature) {
  return stripeClient().webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
}

// Webhook イベントの処理本体。Stripe SDK に依存しないのでテストから直接呼べる。
// 同じイベントIDは1回しか処理しない。
export function handleStripeEvent(db, event) {
  return tx(db, () => {
    const seen = db.prepare('INSERT OR IGNORE INTO stripe_events (id) VALUES (?)').run(event.id);
    if (seen.changes === 0) return 'duplicate';
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        // コンビニ・銀行振込は completed 時点で unpaid。入金後の async_payment_succeeded で付与する。
        if (obj.mode === 'payment' && obj.payment_status === 'paid') grantPurchasedPoints(db, obj);
        return 'ok';
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        upsertSubscription(db, obj);
        return 'ok';
      case 'invoice.paid':
        grantSubscriptionPoints(db, obj);
        return 'ok';
      case 'charge.refunded':
      case 'charge.dispute.created': {
        const paymentIntent = obj.payment_intent;
        if (paymentIntent) revokeLot(db, { source: 'stripe_purchase', sourceRef: String(paymentIntent) });
        return 'ok';
      }
      default:
        return 'ignored';
    }
  });
}

function grantPurchasedPoints(db, session) {
  const pack = POINT_PACKS[session.metadata?.pack];
  const userId = Number(session.metadata?.userId);
  if (!pack || !userId) return;
  grantPoints(db, {
    userId,
    kind: 'paid',
    amount: pack.points,
    source: 'stripe_purchase',
    // 返金・チャージバックは PaymentIntent 単位で届くので、それで紐付ける。
    sourceRef: String(session.payment_intent ?? session.id),
  });
}

function upsertSubscription(db, sub) {
  const userId = Number(sub.metadata?.userId);
  const plan = sub.metadata?.plan;
  if (!userId || !PLANS[plan]) return;
  // API バージョンにより期間はサブスク直下か items 側にある。
  const item = sub.items?.data?.[0] ?? {};
  const start = sub.current_period_start ?? item.current_period_start;
  const end = sub.current_period_end ?? item.current_period_end;
  if (!start || !end) return;
  db.prepare(`
    INSERT INTO subscriptions (user_id, plan, interval, status, stripe_subscription_id, current_period_start, current_period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      plan = excluded.plan, interval = excluded.interval, status = excluded.status,
      stripe_subscription_id = excluded.stripe_subscription_id,
      current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end
  `).run(
    userId, plan, sub.metadata?.interval ?? 'month', sub.status, sub.id,
    sqlTime(new Date(start * 1000)), sqlTime(new Date(end * 1000)),
  );
}

// サブスク更新ごとの特典ポイント（無償ポイント、契約期間末で失効）。
function grantSubscriptionPoints(db, invoice) {
  const meta = invoice.parent?.subscription_details?.metadata ?? invoice.subscription_details?.metadata;
  const userId = Number(meta?.userId);
  const plan = PLANS[meta?.plan];
  if (!userId || !plan?.monthlyPoints) return;
  const months = meta.interval === 'year' ? 12 : 1;
  const periodEnd = invoice.lines?.data?.[0]?.period?.end;
  grantPoints(db, {
    userId,
    kind: 'free',
    amount: plan.monthlyPoints * months,
    source: 'subscription_bonus',
    sourceRef: invoice.id,
    expiresAt: periodEnd ? new Date(periodEnd * 1000) : null,
  });
}
