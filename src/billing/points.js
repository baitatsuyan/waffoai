import { sqlTime } from '../db.js';

export class InsufficientPointsError extends Error {
  constructor(needed, available) {
    super(`ポイントが不足しています（必要 ${needed}pt / 残高 ${available}pt）`);
    this.needed = needed;
    this.available = available;
  }
}

// ポイント付与。(source, sourceRef) が同じ付与は1回しか行わない（Webhook 再送対策）。
// 戻り値: 付与したら true、既に付与済みなら false。
export function grantPoints(db, { userId, kind, amount, source, sourceRef = null, expiresAt = null }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
  const res = db.prepare(`
    INSERT OR IGNORE INTO point_lots (user_id, kind, amount, remaining, source, source_ref, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, kind, amount, amount, source, sourceRef, expiresAt ? sqlTime(expiresAt) : null);
  return res.changes === 1;
}

export function getBalance(db, userId, now = new Date()) {
  const rows = db.prepare(`
    SELECT kind, COALESCE(SUM(remaining), 0) AS total FROM point_lots
    WHERE user_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
    GROUP BY kind
  `).all(userId, sqlTime(now));
  const balance = { paid: 0, free: 0 };
  for (const r of rows) balance[r.kind] = r.total;
  return { ...balance, total: balance.paid + balance.free };
}

// ポイント消費。期限のある無償ポイント（期限が近い順）→ 有償ポイント（古い順）の順に使う。
// 呼び出し側でトランザクションを張ること。
export function spendPoints(db, { userId, amount, feature, characterId = null, now = new Date() }) {
  const lots = db.prepare(`
    SELECT id, kind, remaining FROM point_lots
    WHERE user_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY CASE kind WHEN 'free' THEN 0 ELSE 1 END, expires_at IS NULL, expires_at, id
  `).all(userId, sqlTime(now));
  const available = lots.reduce((s, l) => s + l.remaining, 0);
  if (available < amount) throw new InsufficientPointsError(amount, available);

  const updateLot = db.prepare('UPDATE point_lots SET remaining = remaining - ? WHERE id = ?');
  const insertSpend = db.prepare(`
    INSERT INTO point_spends (user_id, lot_id, kind, amount, feature, character_id) VALUES (?, ?, ?, ?, ?, ?)
  `);
  let left = amount;
  const spent = { paid: 0, free: 0, spendIds: [] };
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.remaining);
    updateLot.run(take, lot.id);
    const r = insertSpend.run(userId, lot.id, lot.kind, take, feature, characterId);
    spent[lot.kind] += take;
    spent.spendIds.push(Number(r.lastInsertRowid));
    left -= take;
  }
  return spent;
}

// 消費の取り消し（生成失敗時など）。ロットに戻して消費履歴を削除する。
export function restoreSpends(db, spendIds) {
  const get = db.prepare('SELECT lot_id, amount FROM point_spends WHERE id = ?');
  const restore = db.prepare('UPDATE point_lots SET remaining = remaining + ? WHERE id = ?');
  const del = db.prepare('DELETE FROM point_spends WHERE id = ?');
  for (const id of spendIds) {
    const s = get.get(id);
    if (!s) continue;
    restore.run(s.amount, s.lot_id);
    del.run(id);
  }
}

// 返金・チャージバック時：その購入で付与したロットの未使用分を失効させる。
export function revokeLot(db, { source, sourceRef }) {
  return db.prepare(`UPDATE point_lots SET remaining = 0 WHERE source = ? AND source_ref = ?`).run(source, sourceRef).changes;
}

// 資金決済法の「基準日未使用残高」（有償ポイントのみ）。3/31・9/30 時点で1,000万円超なら届出と供託が必要。
export function unusedPaidBalance(db) {
  const r = db.prepare(`SELECT COALESCE(SUM(remaining), 0) AS total FROM point_lots WHERE kind = 'paid'`).get();
  return r.total;
}
