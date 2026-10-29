import { CREATOR_REWARD } from '../config.js';
import { sqlTime } from '../db.js';

export function getRewardSummary(db, creatorId, now = new Date()) {
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN payout_id IS NULL AND available_at <= ? THEN amount_r END), 0) AS available,
      COALESCE(SUM(CASE WHEN payout_id IS NULL AND available_at > ? THEN amount_r END), 0) AS pending,
      COALESCE(SUM(CASE WHEN payout_id IS NOT NULL THEN amount_r END), 0) AS requestedOrPaid
    FROM creator_rewards WHERE creator_id = ?
  `).get(sqlTime(now), sqlTime(now), creatorId);
  return { ...r, minPayoutR: CREATOR_REWARD.minPayoutR };
}

// 出金申請。保留期間を過ぎた報酬をまとめて1件の申請にする。実際の送金は運営が手動で行う想定。
// 呼び出し側でトランザクションを張ること。
export function requestPayout(db, creatorId, now = new Date()) {
  const { available } = getRewardSummary(db, creatorId, now);
  if (available < CREATOR_REWARD.minPayoutR) {
    throw new Error(`出金可能額が最低額 ${CREATOR_REWARD.minPayoutR}R に達していません（現在 ${available}R）`);
  }
  const p = db.prepare(`INSERT INTO payouts (creator_id, amount_r, status) VALUES (?, ?, 'requested')`).run(creatorId, available);
  const payoutId = Number(p.lastInsertRowid);
  db.prepare('UPDATE creator_rewards SET payout_id = ? WHERE creator_id = ? AND payout_id IS NULL AND available_at <= ?')
    .run(payoutId, creatorId, sqlTime(now));
  return { payoutId, amountR: available };
}
