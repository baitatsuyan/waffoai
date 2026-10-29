import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { env, PLANS, POINT_PACKS, POINT_COSTS, CHAT_HISTORY_LIMIT, CREATOR_REWARD } from './config.js';
import { tx } from './db.js';
import { createLoginLink, consumeLoginToken, startSession, endSession, currentUser } from './auth.js';
import { getBalance, unusedPaidBalance, InsufficientPointsError } from './billing/points.js';
import { getUsage, chargeFor, refundCharge, PaymentRequiredError } from './billing/plans.js';
import { getRewardSummary, requestPayout } from './billing/rewards.js';
import { WaffoError, WaffoUnknownStatusError } from '@waffo/waffo-node';
import * as waffoBilling from './billing/waffo.js';
import { WaffoApiError } from './billing/waffo.js';
import { generateReply as defaultGenerateReply, generateText as defaultGenerateText } from './llm/provider.js';
import { PERSONAS, VOICES, INTERPRETER_LANGUAGES } from './personas.js';
import { buildInstructions } from './prompt.js';
import { chatToolDefs, executeTool, ToolError } from './tools.js';
import { checkUserText, ageGate, trackPartnerUsage } from './safety.js';
import { companionRoutes } from './routes/companion.js';
import { voiceRoutes } from './routes/voice.js';
import { homeRoutes, touchCompanion } from './routes/home.js';
import { officialOwnerId, OFFICIAL_EMAIL } from './seed.js';
import { createMailer, loginMail } from './mail.js';

const VISIBILITIES = ['public', 'unlisted', 'private'];
const MAX_MESSAGE_CHARS = 2000;
const CHARACTER_LIMITS = { name: 50, tagline: 200, world_setting: 4000, profile: 4000, opening: 2000, tags: 200 };

export function createApp({
  db, waffo = null, generateReply = defaultGenerateReply, generateText = defaultGenerateText,
  realtime = null, isProduction = process.env.NODE_ENV === 'production', sendMail = createMailer(),
}) {
  const app = new Hono();

  const requireUser = async (c, next) => {
    const user = currentUser(c, db);
    if (!user) return c.json({ error: 'ログインが必要です' }, 401);
    c.set('user', user);
    await next();
  };

  // 公開・限定公開は誰でも、非公開は作成者だけが読める。
  const loadReadableCharacter = (id, user) => {
    const chara = db.prepare('SELECT * FROM characters WHERE id = ?').get(Number(id));
    if (!chara) return null;
    if (chara.visibility === 'private' && chara.creator_id !== user?.id) return null;
    return chara;
  };

  // Render などのヘルスチェック用。DB に触れて、ディスクが使えることも確かめる。
  app.get('/healthz', (c) => {
    db.prepare('SELECT 1').get();
    return c.text('ok');
  });

  // ---- 認証 ----
  app.post('/auth/login', async (c) => {
    const { email } = await c.req.json().catch(() => ({}));
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320
      || email.trim().toLowerCase() === OFFICIAL_EMAIL) {
      return c.json({ error: 'メールアドレスが正しくありません' }, 400);
    }
    if (isProduction && !sendMail) return c.json({ error: 'ただいまログインを受け付けていません' }, 503);
    const link = createLoginLink(db, email.trim().toLowerCase());
    if (sendMail) {
      try {
        await sendMail({ to: email.trim(), ...loginMail(link) });
      } catch (err) {
        console.error(err);
        return c.json({ error: 'メールを送れませんでした。時間をおいてお試しください' }, 502);
      }
    }
    // 本番ではリンクをログにも画面にも出さない（ログを見られる人がなりすませるため）
    if (!isProduction) console.log(`[login link] ${email}: ${link}`);
    return c.json({ ok: true, ...(isProduction ? {} : { devLink: link }) });
  });

  app.get('/auth/verify', (c) => {
    const user = consumeLoginToken(db, c.req.query('token') ?? '');
    if (!user) return c.text('ログインリンクが無効か期限切れです。もう一度お試しください。', 400);
    startSession(c, db, user.id);
    return c.redirect('/');
  });

  app.post('/auth/logout', (c) => {
    endSession(c, db);
    return c.json({ ok: true });
  });

  // ---- アカウント ----
  app.get('/api/me', (c) => {
    const user = currentUser(c, db);
    if (!user) return c.json({ user: null });
    return c.json({
      user: { id: user.id, email: user.email, displayName: user.display_name, birthDate: user.birth_date },
      points: getBalance(db, user.id),
      usage: getUsage(db, user.id),
      subscription: db.prepare(`
        SELECT plan, interval, status, current_period_end AS currentPeriodEnd, pending_plan AS pendingPlan
        FROM subscriptions WHERE user_id = ?
      `).get(user.id) ?? null,
      rewards: getRewardSummary(db, user.id),
    });
  });

  // ---- 役割・声の一覧（作成画面用） ----
  app.get('/api/personas', (c) => c.json({
    personas: Object.fromEntries(Object.entries(PERSONAS).map(([k, p]) => [k, { label: p.label, tools: p.tools }])),
    voices: VOICES,
    languages: INTERPRETER_LANGUAGES,
    voiceAvailable: Boolean(realtime),
  }));

  // ---- キャラクター ----
  app.get('/api/characters', (c) => {
    const sort = c.req.query('sort') === 'new' ? 'c.created_at DESC' : 'c.chat_count DESC, c.id DESC';
    const q = (c.req.query('q') ?? '').trim();
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const rows = db.prepare(`
      SELECT c.id, c.name, c.tagline, c.tags, c.persona, c.role, c.chat_count, u.display_name AS creator,
        c.creator_id = ? AS official
      FROM characters c JOIN users u ON u.id = c.creator_id
      WHERE c.visibility = 'public'
        AND (? = '' OR c.name LIKE ? ESCAPE '\\' OR c.tagline LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\')
      ORDER BY official DESC, ${sort} LIMIT 60
    `).all(officialOwnerId(db) ?? -1, q, like, like, like);
    return c.json({ characters: rows });
  });

  app.get('/api/characters/:id', (c) => {
    const chara = loadReadableCharacter(c.req.param('id'), currentUser(c, db));
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const user = currentUser(c, db);
    const creator = db.prepare('SELECT display_name FROM users WHERE id = ?').get(chara.creator_id);
    const companion = user ? Boolean(db.prepare('SELECT 1 FROM user_companions WHERE user_id = ? AND character_id = ?').get(user.id, chara.id)) : false;
    // 作成者による調整（tweak）は作成者以外には見せない
    const { tweak, ...publicFields } = chara;
    return c.json({ character: { ...publicFields, ...(user?.id === chara.creator_id ? { tweak } : {}), creator: creator.display_name, official: chara.creator_id === officialOwnerId(db), companion } });
  });

  app.get('/api/my/characters', requireUser, (c) => {
    const rows = db.prepare('SELECT id, name, tagline, persona, role, visibility, chat_count FROM characters WHERE creator_id = ? ORDER BY id DESC')
      .all(c.get('user').id);
    return c.json({ characters: rows });
  });

  app.post('/api/characters', requireUser, async (c) => {
    const input = validateCharacter(await c.req.json().catch(() => null));
    if (input.error) return c.json(input, 400);
    const r = db.prepare(`
      INSERT INTO characters (creator_id, name, tagline, world_setting, profile, opening, tags, visibility, persona, role, voice, voice_speed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c.get('user').id, input.name, input.tagline, input.world_setting, input.profile, input.opening, input.tags, input.visibility,
      input.persona, input.role, input.voice, input.voice_speed);
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  app.put('/api/characters/:id', requireUser, async (c) => {
    const input = validateCharacter(await c.req.json().catch(() => null));
    if (input.error) return c.json(input, 400);
    const r = db.prepare(`
      UPDATE characters SET name = ?, tagline = ?, world_setting = ?, profile = ?, opening = ?, tags = ?, visibility = ?,
        persona = ?, role = ?, voice = ?, voice_speed = ?, updated_at = datetime('now')
      WHERE id = ? AND creator_id = ?
    `).run(input.name, input.tagline, input.world_setting, input.profile, input.opening, input.tags, input.visibility,
      input.persona, input.role, input.voice, input.voice_speed, Number(c.req.param('id')), c.get('user').id);
    if (r.changes === 0) return c.json({ error: 'キャラが見つかりません' }, 404);
    return c.json({ ok: true });
  });

  // ---- 会話 ----
  app.post('/api/characters/:id/conversations', requireUser, (c) => {
    const chara = loadReadableCharacter(c.req.param('id'), c.get('user'));
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const gate = ageGate(c.get('user'), chara);
    if (gate) return c.json(gate, 403);
    const r = db.prepare('INSERT INTO conversations (user_id, character_id) VALUES (?, ?)').run(c.get('user').id, chara.id);
    touchCompanion(db, c.get('user').id, chara.id);
    db.prepare('UPDATE characters SET chat_count = chat_count + 1 WHERE id = ?').run(chara.id);
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });

  // そのキャラとの最新の会話（なければ作る）。ホームや相棒の画面から続きを開く。
  app.post('/api/characters/:id/conversations/latest', requireUser, (c) => {
    const user = c.get('user');
    const chara = loadReadableCharacter(c.req.param('id'), user);
    if (!chara) return c.json({ error: 'キャラが見つかりません' }, 404);
    const gate = ageGate(user, chara);
    if (gate) return c.json(gate, 403);
    let conv = db.prepare('SELECT id FROM conversations WHERE user_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1').get(user.id, chara.id);
    if (!conv) {
      conv = { id: Number(db.prepare('INSERT INTO conversations (user_id, character_id) VALUES (?, ?)').run(user.id, chara.id).lastInsertRowid) };
      db.prepare('UPDATE characters SET chat_count = chat_count + 1 WHERE id = ?').run(chara.id);
    }
    touchCompanion(db, user.id, chara.id);
    return c.json({ id: conv.id });
  });

  app.get('/api/conversations/:id', requireUser, (c) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(c.req.param('id')), c.get('user').id);
    if (!conv) return c.json({ error: '会話が見つかりません' }, 404);
    const chara = db.prepare('SELECT id, name, tagline, opening FROM characters WHERE id = ?').get(conv.character_id);
    const messages = db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
    return c.json({ conversation: conv, character: chara, messages });
  });

  app.post('/api/conversations/:id/messages', requireUser, async (c) => {
    const user = c.get('user');
    const { content } = await c.req.json().catch(() => ({}));
    if (typeof content !== 'string' || !content.trim() || content.length > MAX_MESSAGE_CHARS) {
      return c.json({ error: `メッセージは1〜${MAX_MESSAGE_CHARS}文字で入力してください` }, 400);
    }
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(c.req.param('id')), user.id);
    if (!conv) return c.json({ error: '会話が見つかりません' }, 404);
    const chara = loadReadableCharacter(conv.character_id, user);
    if (!chara) return c.json({ error: 'このキャラは現在利用できません' }, 404);
    const gate = ageGate(user, chara);
    if (gate) return c.json(gate, 403);
    if (chara.persona === 'interpreter') return c.json({ error: '通訳キャラは音声のトークでご利用ください' }, 400);
    const safety = checkUserText(db, { userId: user.id, characterId: chara.id, text: content });

    // 先に課金（枠かポイント）を確定させ、生成に失敗したら取り消す。
    let receipt;
    try {
      receipt = tx(db, () => chargeFor(db, { userId: user.id, feature: 'chat_message', characterId: chara.id }));
    } catch (err) {
      if (err instanceof InsufficientPointsError || err instanceof PaymentRequiredError) {
        return c.json({ error: '本日の無料枠を使い切りました。プランの加入かポイントの購入で続けられます。', code: 'payment_required' }, 402);
      }
      throw err;
    }

    const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
      .all(conv.id, CHAT_HISTORY_LIMIT - 1).reverse();
    history.push({ role: 'user', content: content.trim() });

    // キャラが会話中に使う道具（記憶・予定・記録）。失敗はキャラに伝えて会話を続けさせる。
    const runTool = (name, args) => {
      try {
        return executeTool(db, { userId: user.id, chara, name, args });
      } catch (err) {
        if (err instanceof ToolError) return { ok: false, error: err.message };
        throw err;
      }
    };
    let reply;
    try {
      reply = await generateReply({
        instructions: buildInstructions(db, chara, { userId: user.id, mode: 'text' }),
        opening: chara.opening,
        history,
        tools: chatToolDefs(chara),
        runTool,
      });
    } catch (err) {
      tx(db, () => refundCharge(db, receipt));
      console.error('generateReply failed:', err);
      return c.json({ error: '返答の生成に失敗しました。消費した枠・ポイントは戻しています。' }, 502);
    }

    const saved = tx(db, () => {
      const ins = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)');
      ins.run(conv.id, 'user', content.trim());
      const r = ins.run(conv.id, 'assistant', reply.text);
      return Number(r.lastInsertRowid);
    });
    const nudge = trackPartnerUsage(db, { userId: user.id, chara, messages: 1 });
    return c.json({
      message: { id: saved, role: 'assistant', content: reply.text },
      toolEvents: (reply.toolEvents ?? []).map((e) => ({ name: e.name, ok: e.result?.ok !== false })),
      notices: [safety, nudge].filter(Boolean),
      charged: { via: receipt.via, points: receipt.cost ?? 0 },
      points: getBalance(db, user.id),
      usage: getUsage(db, user.id),
    });
  });

  homeRoutes(app, { db, requireUser, loadReadableCharacter });
  companionRoutes(app, { db, requireUser, loadReadableCharacter, generateText });
  voiceRoutes(app, { db, requireUser, loadReadableCharacter, realtime });

  // ---- 課金 ----
  app.get('/api/billing/catalog', (c) =>
    c.json({ plans: PLANS, pointPacks: POINT_PACKS, pointCosts: POINT_COSTS, creatorReward: CREATOR_REWARD }));

  const requireWaffo = async (c, next) => {
    if (!waffo) return c.json({ error: '決済は現在準備中です（決済サービスの鍵が未設定）' }, 503);
    await next();
  };
  app.use('/api/billing/*', async (c, next) => (c.req.path === '/api/billing/catalog' ? next() : requireWaffo(c, next)));
  app.use('/api/waffo/*', requireWaffo);

  // Waffo API の失敗は 502、入力や状態の問題（加入済みなど）は 400 で返す。
  const billingCall = async (c, fn) => {
    try {
      return c.json(await fn());
    } catch (err) {
      if (err instanceof WaffoApiError || err instanceof WaffoError || err instanceof WaffoUnknownStatusError) {
        console.error('Waffo API call failed:', err);
        return c.json({ error: '決済サービスとの通信に失敗しました。時間をおいてもう一度お試しください。' }, 502);
      }
      return c.json({ error: err.message }, 400);
    }
  };

  app.post('/api/billing/checkout/subscription', requireUser, async (c) => {
    const { plan, interval } = await c.req.json().catch(() => ({}));
    if (!PLANS[plan]?.priceJpy?.[interval] || plan === 'free') return c.json({ error: 'プランが正しくありません' }, 400);
    return billingCall(c, async () => ({ url: await waffoBilling.createSubscriptionCheckout(db, waffo, c.get('user'), plan, interval) }));
  });

  app.post('/api/billing/checkout/points', requireUser, async (c) => {
    const { pack } = await c.req.json().catch(() => ({}));
    if (!POINT_PACKS[pack]) return c.json({ error: '商品が正しくありません' }, 400);
    return billingCall(c, async () => ({ url: await waffoBilling.createPointCheckout(db, waffo, c.get('user'), pack) }));
  });

  // 決済画面から戻ったとき、Webhook の到着を待たずに結果を確認する。
  app.post('/api/billing/payments/:id/sync', requireUser, (c) =>
    billingCall(c, async () => ({ status: await waffoBilling.syncPayment(db, waffo, c.get('user'), c.req.param('id')) })));

  app.post('/api/billing/subscription/cancel', requireUser, (c) =>
    billingCall(c, () => waffoBilling.cancelSubscription(db, waffo, c.get('user'))));

  // 支払い方法の変更などは Waffo のサブスク管理ページで行う。
  app.post('/api/billing/subscription/manage', requireUser, (c) =>
    billingCall(c, async () => ({ url: await waffoBilling.getManagementUrl(db, waffo, c.get('user')) })));

  // Waffo は HTTP 200 と署名付きの {"message":"success"|"failed"} を期待する（failed なら再送される）。
  app.post('/api/waffo/webhook', async (c) => {
    const result = waffoBilling.processWebhook(db, waffo, await c.req.text(), c.req.header('x-signature') ?? '');
    return c.body(result.body, 200, { 'Content-Type': 'application/json', 'X-SIGNATURE': result.signature });
  });

  // ---- クリエイター報酬 ----
  app.post('/api/creator/payouts', requireUser, (c) => {
    try {
      return c.json(tx(db, () => requestPayout(db, c.get('user').id)), 201);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ---- 運営 ----
  app.get('/api/admin/funds-report', requireUser, (c) => {
    if (!env.adminEmails.includes(c.get('user').email)) return c.json({ error: 'forbidden' }, 403);
    const unused = unusedPaidBalance(db);
    return c.json({
      unusedPaidPoints: unused,
      // 1pt = 1円で発行しているため、未使用残高（円）はポイント数と同じ。
      unusedPaidJpy: unused,
      needsFilingAndDeposit: unused > 10_000_000,
      note: '資金決済法：基準日（3/31・9/30）の未使用残高が1,000万円を超えると、届出とその半額以上の供託が必要です。',
    });
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'サーバエラーが発生しました' }, 500);
  });

  app.use('/*', serveStatic({ root: './public' }));
  return app;
}

function validateCharacter(body) {
  if (!body || typeof body !== 'object') return { error: '入力が正しくありません' };
  const out = {};
  for (const [field, max] of Object.entries(CHARACTER_LIMITS)) {
    const v = body[field] ?? '';
    if (typeof v !== 'string' || v.length > max) return { error: `${field} は${max}文字以内で入力してください` };
    out[field] = v.trim();
  }
  if (!out.name) return { error: 'キャラ名は必須です' };
  if (!VISIBILITIES.includes(body.visibility)) return { error: '公開範囲が正しくありません' };
  out.visibility = body.visibility;
  out.persona = body.persona ?? 'chat';
  if (!PERSONAS[out.persona]) return { error: '役割が正しくありません' };
  out.role = typeof body.role === 'string' ? body.role.trim().slice(0, 400) : '';
  if (out.persona === 'other' && !out.role) return { error: '「その他」を選んだときは役割の説明を入力してください' };
  out.voice = body.voice ?? 'marin';
  if (!VOICES.includes(out.voice)) return { error: '声が正しくありません' };
  out.voice_speed = Number(body.voice_speed ?? 1);
  if (!(out.voice_speed >= 0.25 && out.voice_speed <= 1.5)) return { error: '話す速さは 0.25〜1.5 で指定してください' };
  return out;
}
