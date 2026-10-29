import { env } from '../config.js';
import { tx } from '../db.js';
import { buildInstructions } from '../prompt.js';
import { chargeFor, refundCharge, PaymentRequiredError } from '../billing/plans.js';
import { InsufficientPointsError } from '../billing/points.js';
import { ageOf } from '../safety.js';

// 記憶・記録（キャラのノート）、調整（プロンプトでの微修正）と版管理、キャラからのメッセージ、Web Push。

const MAX_TWEAK = 1000;
const MAX_VERSIONS = 20;

export function companionRoutes(app, { db, requireUser, loadReadableCharacter, generateText }) {
  // ---- 年齢（恋人ペルソナの利用条件） ----
  app.post('/api/me/birth-date', requireUser, async (c) => {
    const { birthDate } = await c.req.json().catch(() => ({}));
    const age = ageOf(birthDate);
    if (age === null || age < 0 || age > 120) return c.json({ error: '生年月日は YYYY-MM-DD で入力してください' }, 400);
    db.prepare('UPDATE users SET birth_date = ? WHERE id = ?').run(birthDate, c.get('user').id);
    return c.json({ ok: true, age });
  });

  // ---- 記憶 ----
  app.get('/api/memories', requireUser, (c) => {
    const cid = Number(c.req.query('character_id') || 0);
    const rows = db.prepare(`
      SELECT m.id, m.character_id, ch.name AS character_name, m.kind, m.content, m.scope, m.created_at
      FROM memories m JOIN characters ch ON ch.id = m.character_id
      WHERE m.user_id = ? AND (? = 0 OR m.character_id = ? OR m.scope = 'shared')
      ORDER BY m.id DESC
    `).all(c.get('user').id, cid, cid);
    return c.json({ memories: rows });
  });

  app.post('/api/memories', requireUser, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const chara = loadReadableCharacter(b.characterId, c.get('user'));
    const content = typeof b.content === 'string' ? b.content.trim().slice(0, 200) : '';
    if (!chara || !content) return c.json({ error: 'キャラと内容を指定してください' }, 400);
    const r = db.prepare('INSERT INTO memories (user_id, character_id, kind, content, scope) VALUES (?, ?, ?, ?, ?)')
      .run(c.get('user').id, chara.id, String(b.kind || 'その他').slice(0, 20), content, b.scope === 'shared' ? 'shared' : 'private');
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  // 共有範囲の変更（このキャラだけ ⇄ 全キャラ）
  app.patch('/api/memories/:id', requireUser, async (c) => {
    const { scope } = await c.req.json().catch(() => ({}));
    if (!['private', 'shared'].includes(scope)) return c.json({ error: 'scope が正しくありません' }, 400);
    const r = db.prepare('UPDATE memories SET scope = ? WHERE id = ? AND user_id = ?').run(scope, Number(c.req.param('id')), c.get('user').id);
    return r.changes ? c.json({ ok: true }) : c.json({ error: '見つかりません' }, 404);
  });

  app.delete('/api/memories/:id', requireUser, (c) => {
    const r = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(Number(c.req.param('id')), c.get('user').id);
    return r.changes ? c.json({ ok: true }) : c.json({ error: '見つかりません' }, 404);
  });

  // ---- 記録（予定・タスク・トレーニング・小テスト・単語カード） ----
  app.get('/api/records', requireUser, (c) => {
    const type = c.req.query('type') ?? '';
    const cid = Number(c.req.query('character_id') || 0);
    const rows = db.prepare(`
      SELECT r.id, r.character_id, ch.name AS character_name, r.type, r.data, r.due_at, r.done, r.created_at
      FROM records r JOIN characters ch ON ch.id = r.character_id
      WHERE r.user_id = ? AND (? = '' OR r.type = ?) AND (? = 0 OR r.character_id = ?)
      ORDER BY r.done, CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at, r.id DESC LIMIT 200
    `).all(c.get('user').id, type, type, cid, cid);
    return c.json({ records: rows.map((r) => ({ ...r, data: JSON.parse(r.data), done: Boolean(r.done) })) });
  });

  app.patch('/api/records/:id', requireUser, async (c) => {
    const { done } = await c.req.json().catch(() => ({}));
    const r = db.prepare('UPDATE records SET done = ? WHERE id = ? AND user_id = ?').run(done ? 1 : 0, Number(c.req.param('id')), c.get('user').id);
    return r.changes ? c.json({ ok: true }) : c.json({ error: '見つかりません' }, 404);
  });

  app.delete('/api/records/:id', requireUser, (c) => {
    const r = db.prepare('DELETE FROM records WHERE id = ? AND user_id = ?').run(Number(c.req.param('id')), c.get('user').id);
    return r.changes ? c.json({ ok: true }) : c.json({ error: '見つかりません' }, 404);
  });

  // ---- 調整 ----
  // scope=creator は作成者だけが変更でき、公開中のキャラに反映される。scope=personal は自分との会話だけに効く。
  const tweakOwner = (chara, user, scope) => (scope === 'creator' ? (chara.creator_id === user.id ? null : false) : user.id);

  app.get('/api/characters/:id/tweaks', requireUser, (c) => {
    const user = c.get('user');
    const chara = loadReadableCharacter(c.req.param('id'), user);
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const isCreator = chara.creator_id === user.id;
    const versions = db.prepare(`
      SELECT id, user_id IS NULL AS creator, text, created_at FROM tweak_versions
      WHERE character_id = ? AND (user_id = ? OR (user_id IS NULL AND ?)) ORDER BY id DESC LIMIT ?
    `).all(chara.id, user.id, isCreator ? 1 : 0, MAX_VERSIONS);
    return c.json({
      isCreator,
      creator: chara.tweak,
      personal: db.prepare('SELECT text FROM user_tweaks WHERE character_id = ? AND user_id = ?').get(chara.id, user.id)?.text ?? '',
      versions: versions.map((v) => ({ ...v, scope: v.creator ? 'creator' : 'personal' })),
    });
  });

  app.put('/api/characters/:id/tweaks', requireUser, async (c) => {
    const user = c.get('user');
    const chara = loadReadableCharacter(c.req.param('id'), user);
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const { scope, text } = await c.req.json().catch(() => ({}));
    if (!['creator', 'personal'].includes(scope) || typeof text !== 'string' || text.length > MAX_TWEAK) {
      return c.json({ error: `調整は${MAX_TWEAK}文字以内で入力してください` }, 400);
    }
    const owner = tweakOwner(chara, user, scope);
    if (owner === false) return c.json({ error: '公開中の調整は作成者だけが変更できます' }, 403);
    saveTweak(db, chara, owner, text.trim());
    return c.json({ ok: true });
  });

  // 以前の版に戻す（今の内容も版として残るので、何度でも行き来できる）
  app.post('/api/characters/:id/tweaks/revert', requireUser, async (c) => {
    const user = c.get('user');
    const chara = loadReadableCharacter(c.req.param('id'), user);
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const { versionId } = await c.req.json().catch(() => ({}));
    const v = db.prepare('SELECT * FROM tweak_versions WHERE id = ? AND character_id = ?').get(Number(versionId), chara.id);
    if (!v) return c.json({ error: '版が見つかりません' }, 404);
    if (v.user_id === null ? chara.creator_id !== user.id : v.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
    saveTweak(db, chara, v.user_id, v.text);
    return c.json({ ok: true, text: v.text });
  });

  // 調整前と調整後の返答を並べて比べる（2回分の会話として課金）
  app.post('/api/characters/:id/tweaks/compare', requireUser, async (c) => {
    const user = c.get('user');
    const chara = loadReadableCharacter(c.req.param('id'), user);
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const { text, sample } = await c.req.json().catch(() => ({}));
    if (typeof text !== 'string' || text.length > MAX_TWEAK) return c.json({ error: '調整の内容が正しくありません' }, 400);
    const prompt = typeof sample === 'string' && sample.trim() ? sample.trim().slice(0, 300) : 'こんにちは。簡単に自己紹介して、最近どうしているか聞いてみて。';
    let receipts;
    try {
      receipts = tx(db, () => [0, 1].map(() => chargeFor(db, { userId: user.id, feature: 'chat_message', characterId: chara.id })));
    } catch (err) {
      if (err instanceof InsufficientPointsError || err instanceof PaymentRequiredError) return c.json({ error: '会話の枠かポイントが足りません', code: 'payment_required' }, 402);
      throw err;
    }
    try {
      const [before, after] = await Promise.all([undefined, text.trim()].map((tweakOverride) => generateText({
        instructions: buildInstructions(db, chara, { userId: user.id, mode: 'text', tweakOverride }),
        prompt,
      })));
      return c.json({ before, after });
    } catch (err) {
      tx(db, () => receipts.forEach((r) => refundCharge(db, r)));
      console.error('tweak compare failed:', err);
      return c.json({ error: '比較の生成に失敗しました' }, 502);
    }
  });

  // ---- キャラからのメッセージ ----
  app.get('/api/characters/:id/proactive', requireUser, (c) => {
    const rows = db.prepare('SELECT kind, time, enabled FROM proactive_settings WHERE user_id = ? AND character_id = ?')
      .all(c.get('user').id, Number(c.req.param('id')));
    const get = (kind, time) => {
      const r = rows.find((x) => x.kind === kind);
      return { enabled: Boolean(r?.enabled), time: r?.time ?? time };
    };
    return c.json({ morning: get('morning', '07:30'), night: get('night', '23:00') });
  });

  app.put('/api/characters/:id/proactive', requireUser, async (c) => {
    const chara = loadReadableCharacter(c.req.param('id'), c.get('user'));
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const b = await c.req.json().catch(() => ({}));
    const upsert = db.prepare(`
      INSERT INTO proactive_settings (user_id, character_id, kind, time, enabled) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, character_id, kind) DO UPDATE SET time = excluded.time, enabled = excluded.enabled
    `);
    for (const kind of ['morning', 'night']) {
      const v = b[kind];
      if (!v) continue;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time ?? '')) return c.json({ error: '時刻は HH:MM で指定してください' }, 400);
      upsert.run(c.get('user').id, chara.id, kind, v.time, v.enabled ? 1 : 0);
    }
    return c.json({ ok: true });
  });

  app.get('/api/inbox', requireUser, (c) => {
    const rows = db.prepare(`
      SELECT i.id, i.character_id, ch.name AS character_name, i.kind, i.text, i.read_at, i.created_at
      FROM inbox i JOIN characters ch ON ch.id = i.character_id WHERE i.user_id = ? ORDER BY i.id DESC LIMIT 50
    `).all(c.get('user').id);
    return c.json({ messages: rows, unread: rows.filter((r) => !r.read_at).length });
  });

  app.post('/api/inbox/read', requireUser, (c) => {
    db.prepare(`UPDATE inbox SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).run(c.get('user').id);
    return c.json({ ok: true });
  });

  // ---- Web Push ----
  app.get('/api/push/key', (c) => c.json({ publicKey: env.vapidPublicKey || null }));

  app.post('/api/push/subscribe', requireUser, async (c) => {
    const sub = await c.req.json().catch(() => ({}));
    if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) {
      return c.json({ error: '購読情報が正しくありません' }, 400);
    }
    db.prepare(`
      INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
    `).run(sub.endpoint, c.get('user').id, sub.keys.p256dh, sub.keys.auth);
    return c.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', requireUser, async (c) => {
    const { endpoint } = await c.req.json().catch(() => ({}));
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(endpoint ?? ''), c.get('user').id);
    return c.json({ ok: true });
  });
}

// 今の調整を版として残してから上書きする。ownerId が null なら作成者の公開調整。
function saveTweak(db, chara, ownerId, text) {
  tx(db, () => {
    const current = ownerId === null
      ? db.prepare('SELECT tweak FROM characters WHERE id = ?').get(chara.id).tweak
      : db.prepare('SELECT text FROM user_tweaks WHERE character_id = ? AND user_id = ?').get(chara.id, ownerId)?.text ?? '';
    if (current === text) return;
    db.prepare('INSERT INTO tweak_versions (character_id, user_id, text) VALUES (?, ?, ?)').run(chara.id, ownerId, current);
    if (ownerId === null) db.prepare('UPDATE characters SET tweak = ? WHERE id = ?').run(text, chara.id);
    else db.prepare(`
      INSERT INTO user_tweaks (character_id, user_id, text) VALUES (?, ?, ?)
      ON CONFLICT (character_id, user_id) DO UPDATE SET text = excluded.text, updated_at = datetime('now')
    `).run(chara.id, ownerId, text);
  });
}
