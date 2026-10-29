import webpush from 'web-push';
import { env } from './config.js';
import { sqlTime } from './db.js';
import { buildInstructions } from './prompt.js';

// キャラから届くメッセージ。毎分 runProactive を呼び、設定時刻を過ぎたもの・近づいた予定を受信箱に入れ、
// Web Push で知らせる。同じ日の同じメッセージは dedupe_key で1回だけ。

const JST_OFFSET_MS = 9 * 3600_000;
const jst = (now) => new Date(now.getTime() + JST_OFFSET_MS).toISOString();

const PROMPTS = {
  morning: '今は朝です。ユーザに朝のメッセージを送ります。今日の予定や期限が近いタスク、覚えていることに自然に触れながら、2文以内で、あなたらしく声をかけてください。メッセージ本文だけを出力してください。',
  night: '今は夜です。ユーザにおやすみ前のメッセージを送ります。今日のことをねぎらい、明日の予定があれば軽く触れて、2文以内で、あなたらしく声をかけてください。メッセージ本文だけを出力してください。',
};

let pushReady = false;
export function setupPush() {
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  pushReady = true;
  return true;
}

export async function sendPush(db, userId, payload) {
  if (!pushReady) return 0;
  const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      sent++;
    } catch (err) {
      // 410/404 は購読が切れている
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
      else console.error('web push failed:', err.statusCode, err.body);
    }
  }
  return sent;
}

function upcomingContext(db, userId, now) {
  const until = sqlTime(new Date(now.getTime() + 36 * 3600_000));
  const rows = db.prepare(`
    SELECT type, data, due_at FROM records
    WHERE user_id = ? AND done = 0 AND type IN ('event', 'task') AND due_at IS NOT NULL AND due_at BETWEEN ? AND ?
    ORDER BY due_at LIMIT 8
  `).all(userId, sqlTime(now), until);
  if (!rows.length) return '';
  return '\n\n# 近い予定・タスク\n' + rows.map((r) => {
    const d = JSON.parse(r.data);
    return r.type === 'event' ? `- 予定 ${d.date} ${d.time} ${d.title}` : `- タスク ${d.title}（期限 ${d.due_date}）`;
  }).join('\n');
}

function insertInbox(db, { userId, characterId, kind, text, dedupeKey }) {
  const r = db.prepare('INSERT OR IGNORE INTO inbox (user_id, character_id, kind, text, dedupe_key) VALUES (?, ?, ?, ?, ?)')
    .run(userId, characterId, kind, text, dedupeKey);
  return r.changes === 1 ? Number(r.lastInsertRowid) : null;
}

export async function runProactive(db, { generateText, push = sendPush, now = new Date() }) {
  const t = jst(now);
  const today = t.slice(0, 10);
  const hhmm = t.slice(11, 16);
  let delivered = 0;

  // 朝・夜のメッセージ
  const due = db.prepare(`
    SELECT s.*, c.name FROM proactive_settings s JOIN characters c ON c.id = s.character_id
    WHERE s.enabled = 1 AND s.time <= ? AND (s.last_sent_date IS NULL OR s.last_sent_date < ?)
  `).all(hhmm, today);
  for (const s of due) {
    // 先に送信済みにして、生成に時間がかかっても二重送信しない
    const claimed = db.prepare(`UPDATE proactive_settings SET last_sent_date = ? WHERE user_id = ? AND character_id = ? AND kind = ? AND (last_sent_date IS NULL OR last_sent_date < ?)`)
      .run(today, s.user_id, s.character_id, s.kind, today);
    if (claimed.changes === 0) continue;
    const chara = db.prepare('SELECT * FROM characters WHERE id = ?').get(s.character_id);
    try {
      const text = await generateText({
        instructions: buildInstructions(db, chara, { userId: s.user_id, mode: 'text', now }) + upcomingContext(db, s.user_id, now),
        prompt: PROMPTS[s.kind],
      });
      const id = insertInbox(db, { userId: s.user_id, characterId: chara.id, kind: s.kind, text, dedupeKey: `${s.user_id}:${chara.id}:${s.kind}:${today}` });
      if (id) {
        delivered++;
        await push(db, s.user_id, { title: chara.name, body: text, url: `/#/inbox` });
      }
    } catch (err) {
      console.error('proactive message failed:', err);
      db.prepare('UPDATE proactive_settings SET last_sent_date = NULL WHERE user_id = ? AND character_id = ? AND kind = ?').run(s.user_id, s.character_id, s.kind);
    }
  }

  // 30分前のリマインド（秘書などが登録した予定）
  const soon = db.prepare(`
    SELECT r.id, r.user_id, r.character_id, r.data, c.name FROM records r JOIN characters c ON c.id = r.character_id
    WHERE r.type = 'event' AND r.done = 0 AND r.due_at BETWEEN ? AND ?
  `).all(sqlTime(now), sqlTime(new Date(now.getTime() + 30 * 60_000)));
  for (const r of soon) {
    const d = JSON.parse(r.data);
    const text = `まもなく ${d.time} から「${d.title}」です。`;
    if (insertInbox(db, { userId: r.user_id, characterId: r.character_id, kind: 'reminder', text, dedupeKey: `reminder:${r.id}` })) {
      delivered++;
      await push(db, r.user_id, { title: r.name, body: text, url: '/#/inbox' });
    }
  }
  return delivered;
}
