import { PLANS, POINT_COSTS, CREATOR_REWARD } from '../config.js';
import { sqlTime } from '../db.js';
import { spendPoints, restoreSpends } from './points.js';

export class PaymentRequiredError extends Error {}

const JST_OFFSET_MS = 9 * 3600_000;
const QUOTA_FIELD ={ chat_message: 'messagesPerPeriod', voice_generation: 'voicePerPeriod' };

// 期間内のサブスク（active、または解約済みでも支払い済み期間内）があればそのプラン、なければ free。
export function getActivePlan(db, userId, now = new Date()) {
  const sub = db.prepare(`
    SELECT plan, interval, status, current_period_start, current_period_end FROM subscriptions
    WHERE user_id = ? AND status IN ('active', 'canceled') AND current_period_end > ?
  `).get(userId, sqlTime(now));
  if (sub && PLANS[sub.plan]) {
    return { plan: sub.plan, ...PLANS[sub.plan], periodKey: `cycle:${sub.current_period_start}`, periodEnd: sub.current_period_end };
  }
  // 無料枠は日本時間の日付で毎日リセット。
  const day = sqlTime(new Date(now.getTime() + JST_OFFSET_MS)).slice(0, 10);
  return { plan: 'free', ...PLANS.free, periodKey: `day:${day}`, periodEnd: `${day} 23:59:59 JST` };
}

export function getUsage(db, userId, now = new Date()) {
  const plan = getActivePlan(db, userId, now);
  const rows = db.prepare('SELECT feature, count FROM usage_counters WHERE user_id = ? AND period_key = ?')
    .all(userId, plan.periodKey);
  const used = Object.fromEntries(rows.map((r) => [r.feature, r.count]));
  return {
    plan: plan.plan,
    periodEnd: plan.periodEnd,
    chat: { used: used.chat_message ?? 0, limit: plan.messagesPerPeriod },
    voice: { used: used.voice_generation ?? 0, limit: plan.voicePerPeriod },
  };
}

// 機能1回分を課金する。プラン枠が残っていれば枠を使い、なければポイントを消費する。
// 呼び出し側でトランザクションを張ること。戻り値の receipt は refundCharge で取り消せる。
export function chargeFor(db, { userId, feature, characterId = null, now = new Date() }) {
  const quotaField = QUOTA_FIELD[feature];
  if (quotaField) {
    const plan = getActivePlan(db, userId, now);
    const row = db.prepare('SELECT count FROM usage_counters WHERE user_id = ? AND feature = ? AND period_key = ?')
      .get(userId, feature, plan.periodKey);
    if ((row?.count ?? 0) < plan[quotaField]) {
      db.prepare(`
        INSERT INTO usage_counters (user_id, feature, period_key, count) VALUES (?, ?, ?, 1)
        ON CONFLICT (user_id, feature, period_key) DO UPDATE SET count = count + 1
      `).run(userId, feature, plan.periodKey);
      return { via: 'quota', userId, feature, periodKey: plan.periodKey };
    }
  }

  const cost = POINT_COSTS[feature];
  if (!cost) throw new PaymentRequiredError(`課金設定のない機能です: ${feature}`);
  const spent = spendPoints(db, { userId, amount: cost, feature, characterId, now });
  const rewardIds = creditCreator(db, { characterId, userId, paidPoints: spent.paid, now });
  return { via: 'points', userId, feature, cost, paid: spent.paid, free: spent.free, spendIds: spent.spendIds, rewardIds };
}

export function refundCharge(db, receipt) {
  if (receipt.via === 'quota') {
    db.prepare('UPDATE usage_counters SET count = count - 1 WHERE user_id = ? AND feature = ? AND period_key = ? AND count > 0')
      .run(receipt.userId, receipt.feature, receipt.periodKey);
    return;
  }
  restoreSpends(db, receipt.spendIds);
  const del = db.prepare('DELETE FROM creator_rewards WHERE id = ? AND payout_id IS NULL');
  for (const id of receipt.rewardIds) del.run(id);
}

// 他人のキャラで有償ポイントが使われたら、その一部をクリエイター報酬として積む。
// 無償ポイントは売上ではないので対象外。自作キャラの自己消費も対象外。
function creditCreator(db, { characterId, userId, paidPoints, now }) {
  if (!characterId || paidPoints === 0) return [];
  const chara = db.prepare('SELECT creator_id FROM characters WHERE id = ?').get(characterId);
  if (!chara || chara.creator_id === userId) return [];
  const availableAt = new Date(now.getTime() + CREATOR_REWARD.holdDays * 86400_000);
  const r = db.prepare('INSERT INTO creator_rewards (creator_id, character_id, amount_r, available_at) VALUES (?, ?, ?, ?)')
    .run(chara.creator_id, characterId, paidPoints * CREATOR_REWARD.paidPointShare, sqlTime(availableAt));
  return [Number(r.lastInsertRowid)];
}
