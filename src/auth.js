import { createHash, randomBytes } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { env, SIGNUP_BONUS_POINTS, FREE_POINT_TTL_DAYS } from './config.js';
import { sqlTime, tx } from './db.js';
import { grantPoints } from './billing/points.js';

const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * 86400_000;
const SESSION_COOKIE = 'sid';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// メールのマジックリンクでログインする（パスワードを持たない）。
// pending は登録前につくった相棒など、リンクを開いたときに反映するもの。メールを別の端末で開いても引き継げるよう、サーバ側に持つ。
export function createLoginLink(db, email, { pending = null, now = new Date() } = {}) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO login_tokens (token_hash, email, expires_at, pending) VALUES (?, ?, ?, ?)')
    .run(sha256(token), email, sqlTime(new Date(now.getTime() + LOGIN_TOKEN_TTL_MS)), pending ? JSON.stringify(pending) : null);
  return `${env.baseUrl}/auth/verify?token=${token}`;
}

// トークンを1回限りで消費し、ユーザと pending を返す（初回ならユーザ作成と登録ボーナス付与）。
export function consumeLoginToken(db, token, now = new Date()) {
  return tx(db, () => {
    const row = db.prepare('SELECT email, pending FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(sha256(token), sqlTime(now));
    if (!row) return null;
    db.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?').run(sqlTime(now), sha256(token));

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(row.email);
    const created = !user;
    if (!user) {
      const r = db.prepare('INSERT INTO users (email, display_name) VALUES (?, ?)').run(row.email, row.email.split('@')[0]);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
      grantPoints(db, {
        userId: user.id,
        kind: 'free',
        amount: SIGNUP_BONUS_POINTS,
        source: 'signup_bonus',
        sourceRef: String(user.id),
        expiresAt: new Date(now.getTime() + FREE_POINT_TTL_DAYS * 86400_000),
      });
    }
    return { user, created, pending: row.pending ? JSON.parse(row.pending) : null };
  });
}

export function startSession(c, db, userId) {
  const sid = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(sid), userId, sqlTime(new Date(Date.now() + SESSION_TTL_MS)));
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: env.baseUrl.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function endSession(c, db) {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(sid));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function currentUser(c, db) {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?
  `).get(sha256(sid), sqlTime(new Date())) ?? null;
}
