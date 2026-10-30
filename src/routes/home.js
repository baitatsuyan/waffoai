import { getUsage } from '../billing/plans.js';
import { getBalance } from '../billing/points.js';
import { officialOwnerId } from '../seed.js';
import { sqlTime } from '../db.js';

// 一般ユーザーの「わたしの相棒」とホーム画面。

const MAX_COMPANIONS = 12;

// 話しかけたキャラは自動で相棒に加え、最近使った順に並べる。
export function touchCompanion(db, userId, characterId) {
  db.prepare(`
    INSERT INTO user_companions (user_id, character_id, last_used_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT (user_id, character_id) DO UPDATE SET last_used_at = excluded.last_used_at
  `).run(userId, characterId);
}

// 相棒に加える。上限を超えるときは加えずに false を返す。
export function addCompanion(db, userId, characterId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM user_companions WHERE user_id = ?').get(userId).n;
  const exists = db.prepare('SELECT 1 FROM user_companions WHERE user_id = ? AND character_id = ?').get(userId, characterId);
  if (!exists && count >= MAX_COMPANIONS) return false;
  db.prepare('INSERT OR IGNORE INTO user_companions (user_id, character_id) VALUES (?, ?)').run(userId, characterId);
  return true;
}

function listCompanions(db, userId) {
  return db.prepare(`
    SELECT c.id, c.name, c.tagline, c.persona, c.role, c.voice, c.voice_speed, c.image, uc.added_at, uc.last_used_at,
      (SELECT m.content FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.user_id = uc.user_id AND cv.character_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT COUNT(*) FROM inbox i WHERE i.user_id = uc.user_id AND i.character_id = c.id AND i.read_at IS NULL) AS unread
    FROM user_companions uc JOIN characters c ON c.id = uc.character_id
    WHERE uc.user_id = ? AND (c.visibility != 'private' OR c.creator_id = uc.user_id)
    ORDER BY COALESCE(uc.last_used_at, uc.added_at) DESC
  `).all(userId);
}

export function homeRoutes(app, { db, requireUser, loadReadableCharacter }) {
  app.get('/api/companions', requireUser, (c) => {
    const user = c.get('user');
    const companions = listCompanions(db, user.id);
    const owner = officialOwnerId(db);
    // まだ相棒がいない人向けのおすすめ（公式の相棒）
    const suggested = db.prepare(`
      SELECT id, name, tagline, persona, role, image FROM characters
      WHERE creator_id = ? AND visibility = 'public' AND id NOT IN (SELECT character_id FROM user_companions WHERE user_id = ?)
      ORDER BY id
    `).all(owner ?? -1, user.id);
    return c.json({ companions, suggested });
  });

  app.post('/api/companions', requireUser, async (c) => {
    const user = c.get('user');
    const { characterId } = await c.req.json().catch(() => ({}));
    const chara = loadReadableCharacter(characterId, user);
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    if (!addCompanion(db, user.id, chara.id)) return c.json({ error: `相棒は${MAX_COMPANIONS}人までです。誰かを外してから加えてください` }, 400);
    return c.json({ ok: true }, 201);
  });

  // 相棒から外す。会話・記憶・記録は残る（また加えれば続きから話せる）。メッセージの送信は止める。
  app.delete('/api/companions/:id', requireUser, (c) => {
    const user = c.get('user');
    const id = Number(c.req.param('id'));
    db.prepare('DELETE FROM user_companions WHERE user_id = ? AND character_id = ?').run(user.id, id);
    db.prepare('UPDATE proactive_settings SET enabled = 0 WHERE user_id = ? AND character_id = ?').run(user.id, id);
    return c.json({ ok: true });
  });

  app.get('/api/home', requireUser, (c) => {
    const user = c.get('user');
    const now = new Date();
    const upcoming = db.prepare(`
      SELECT r.id, r.type, r.data, r.due_at, ch.id AS character_id, ch.name AS character_name FROM records r
      JOIN characters ch ON ch.id = r.character_id
      WHERE r.user_id = ? AND r.done = 0 AND r.type IN ('event', 'task') AND r.due_at IS NOT NULL AND r.due_at BETWEEN ? AND ?
      ORDER BY r.due_at LIMIT 8
    `).all(user.id, sqlTime(new Date(now.getTime() - 12 * 3600_000)), sqlTime(new Date(now.getTime() + 48 * 3600_000)));
    const latest = db.prepare(`
      SELECT i.id, i.character_id, ch.name AS character_name, i.kind, i.text, i.read_at, i.created_at
      FROM inbox i JOIN characters ch ON ch.id = i.character_id WHERE i.user_id = ? ORDER BY i.id DESC LIMIT 3
    `).all(user.id);
    return c.json({
      displayName: user.display_name,
      companions: listCompanions(db, user.id),
      upcoming: upcoming.map((r) => ({ ...r, data: JSON.parse(r.data) })),
      inbox: { unread: db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND read_at IS NULL').get(user.id).n, latest },
      usage: getUsage(db, user.id, now),
      points: getBalance(db, user.id, now),
    });
  });
}
