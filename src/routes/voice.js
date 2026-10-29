import { randomBytes } from 'node:crypto';
import { VOICE_LIMITS } from '../config.js';
import { sqlTime, tx } from '../db.js';
import { VOICES, INTERPRETER_LANGUAGES } from '../personas.js';
import { chargeFor, PaymentRequiredError, getUsage } from '../billing/plans.js';
import { InsufficientPointsError, getBalance } from '../billing/points.js';
import { executeTool, ToolError } from '../tools.js';
import { ageGate, checkUserText, trackPartnerUsage, INTERPRETER_NOTICE } from '../safety.js';
import { directSession, earSession, voiceSession, safetyIdFor, RealtimeError } from '../realtime.js';
import { touchCompanion } from './home.js';

// リアルタイム音声のセッション管理。
// 1つの「音声セッション」に、1対1なら通話1本、グループなら耳1本＋キャラの声 N 本、通訳なら翻訳1本がぶら下がる。
// 課金は分単位：開始時に1分、以後はハートビートごとに経過分を請求し、払えなくなったらサーバから通話を切る。

const MODES = ['direct', 'group', 'interpret'];

export function voiceRoutes(app, { db, requireUser, loadReadableCharacter, realtime }) {
  const requireRealtime = async (c, next) => {
    if (!realtime) return c.json({ error: '音声は現在準備中です（OPENAI_API_KEY 未設定）', code: 'voice_unavailable' }, 503);
    await next();
  };
  app.use('/api/voice/*', requireRealtime);

  const loadSession = (c) => {
    const s = db.prepare('SELECT * FROM voice_sessions WHERE id = ? AND user_id = ?').get(c.req.param('id'), c.get('user').id);
    if (!s) return null;
    return { ...s, characterIds: JSON.parse(s.character_ids), callIds: JSON.parse(s.call_ids) };
  };

  // 参加キャラ数ぶんの「1分」を請求する。耳（聞き取り）は無料。足りなければ例外。
  const chargeMinutes = (userId, charas, minutes) => tx(db, () => {
    for (let i = 0; i < minutes; i++) {
      for (const ch of charas) chargeFor(db, { userId, feature: 'voice_minute', characterId: ch.id });
    }
  });

  const endSession = async (s, reason) => {
    const ended = db.prepare(`UPDATE voice_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`).run(sqlTime(new Date()), reason, s.id);
    if (ended.changes === 0) return;
    await Promise.allSettled(s.callIds.map((id) => realtime.hangup(id)));
  };

  app.post('/api/voice/sessions', requireUser, async (c) => {
    const user = c.get('user');
    const { mode, characterIds } = await c.req.json().catch(() => ({}));
    if (!MODES.includes(mode) || !Array.isArray(characterIds) || !characterIds.length) return c.json({ error: '音声の種類と相手を指定してください' }, 400);
    const ids = [...new Set(characterIds.map(Number))];
    if (ids.length > VOICE_LIMITS.maxGroupMembers) return c.json({ error: `一度に話せるのは${VOICE_LIMITS.maxGroupMembers}人までです` }, 400);
    if (mode !== 'group' && ids.length !== 1) return c.json({ error: '1対1と通訳は1人を指定してください' }, 400);
    const charas = ids.map((id) => loadReadableCharacter(id, user));
    if (charas.some((x) => !x)) return c.json({ error: 'キャラが見つかりません' }, 404);
    if (mode === 'interpret' && charas[0].persona !== 'interpreter') return c.json({ error: '通訳は通訳キャラで使えます' }, 400);
    if (mode !== 'interpret' && charas.some((x) => x.persona === 'interpreter')) return c.json({ error: '通訳キャラは通訳モードで使えます' }, 400);
    for (const ch of charas) {
      const gate = ageGate(user, ch);
      if (gate) return c.json(gate, 403);
    }
    // 同時に開ける音声セッションは1つ（前のは閉じる）
    for (const old of db.prepare('SELECT * FROM voice_sessions WHERE user_id = ? AND ended_at IS NULL').all(user.id)) {
      await endSession({ ...old, callIds: JSON.parse(old.call_ids) }, 'replaced');
    }
    try {
      chargeMinutes(user.id, charas, 1);
    } catch (err) {
      if (err instanceof InsufficientPointsError || err instanceof PaymentRequiredError) {
        return c.json({ error: '音声の無料枠とポイントを使い切りました。プランかポイントで続けられます。', code: 'payment_required' }, 402);
      }
      throw err;
    }
    for (const ch of charas) touchCompanion(db, user.id, ch.id);
    const id = randomBytes(12).toString('hex');
    const now = sqlTime(new Date());
    db.prepare(`INSERT INTO voice_sessions (id, user_id, mode, character_ids, started_at, last_heartbeat_at, billed_minutes) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(id, user.id, mode, JSON.stringify(ids), now, now);
    return c.json({
      sessionId: id,
      mode,
      characters: charas.map((ch) => ({ id: ch.id, name: ch.name, persona: ch.persona, voice: ch.voice })),
      notice: mode === 'interpret' ? INTERPRETER_NOTICE : 'AIが生成した音声です。',
    }, 201);
  });

  // WebRTC の接続。role: direct（1対1）/ ear（グループの聞き取り）/ voice（グループのキャラの声）
  app.post('/api/voice/sessions/:id/connect', requireUser, async (c) => {
    const user = c.get('user');
    const s = loadSession(c);
    if (!s || s.ended_at) return c.json({ error: 'セッションが終了しています' }, 410);
    const { role, characterId, sdp } = await c.req.json().catch(() => ({}));
    if (typeof sdp !== 'string' || !sdp.startsWith('v=') || sdp.length > 20_000) return c.json({ error: 'SDP が正しくありません' }, 400);
    const charas = s.characterIds.map((id) => loadReadableCharacter(id, user)).filter(Boolean);
    let session;
    if (s.mode === 'direct' && role === 'direct') session = directSession(db, charas[0], user.id);
    else if (s.mode === 'group' && role === 'ear') session = earSession();
    else if (s.mode === 'group' && role === 'voice') {
      const chara = charas.find((x) => x.id === Number(characterId));
      if (!chara) return c.json({ error: 'このセッションのキャラではありません' }, 400);
      session = voiceSession(db, chara, user.id, charas);
    } else return c.json({ error: 'role が正しくありません' }, 400);
    // 1セッションの通話数の上限（耳1本＋声4本）
    if (s.callIds.length >= VOICE_LIMITS.maxGroupMembers + 1) return c.json({ error: '接続数の上限です' }, 400);

    try {
      const { answer, callId } = await realtime.createCall({ sdp, session, safetyId: safetyIdFor(user.id) });
      if (callId) {
        db.prepare(`UPDATE voice_sessions SET call_ids = json_insert(call_ids, '$[#]', ?) WHERE id = ?`).run(callId, s.id);
      }
      return c.body(answer, 201, { 'Content-Type': 'application/sdp' });
    } catch (err) {
      if (err instanceof RealtimeError) {
        console.error(err);
        return c.json({ error: '音声サーバに接続できませんでした' }, 502);
      }
      throw err;
    }
  });

  app.post('/api/voice/sessions/:id/translation', requireUser, async (c) => {
    const s = loadSession(c);
    if (!s || s.ended_at || s.mode !== 'interpret') return c.json({ error: 'セッションが正しくありません' }, 400);
    const { language } = await c.req.json().catch(() => ({}));
    if (!INTERPRETER_LANGUAGES[language]) return c.json({ error: '言語が正しくありません' }, 400);
    try {
      return c.json(await realtime.createTranslationSecret({ language, safetyId: safetyIdFor(c.get('user').id) }));
    } catch (err) {
      if (err instanceof RealtimeError) return c.json({ error: '通訳サーバに接続できませんでした' }, 502);
      throw err;
    }
  });

  // 20秒ごとに呼ばれる。経過した分を請求し、払えない・長すぎる場合は切る。
  app.post('/api/voice/sessions/:id/heartbeat', requireUser, async (c) => {
    const user = c.get('user');
    const s = loadSession(c);
    if (!s) return c.json({ error: '見つかりません' }, 404);
    if (s.ended_at) return c.json({ ended: true, reason: s.end_reason });
    const result = await bill(s, user);
    return c.json(result);
  });

  const bill = async (s, user, now = new Date()) => {
    const elapsedMin = Math.ceil((now - new Date(`${s.started_at.replace(' ', 'T')}Z`)) / 60_000);
    const charas = s.characterIds.map((id) => loadReadableCharacter(id, user)).filter(Boolean);
    if (elapsedMin > VOICE_LIMITS.maxCallMinutes) {
      await endSession(s, 'max_duration');
      return { ended: true, reason: 'max_duration' };
    }
    const due = Math.max(0, elapsedMin - s.billed_minutes);
    if (due > 0) {
      try {
        chargeMinutes(user.id, charas, due);
      } catch (err) {
        if (!(err instanceof InsufficientPointsError || err instanceof PaymentRequiredError)) throw err;
        await endSession(s, 'payment_required');
        return { ended: true, reason: 'payment_required' };
      }
      db.prepare('UPDATE voice_sessions SET billed_minutes = ? WHERE id = ?').run(s.billed_minutes + due, s.id);
    }
    db.prepare('UPDATE voice_sessions SET last_heartbeat_at = ? WHERE id = ?').run(sqlTime(now), s.id);
    const nudges = due > 0 ? charas.map((ch) => trackPartnerUsage(db, { userId: user.id, chara: ch, minutes: due, now })).filter(Boolean) : [];
    return { ended: false, minutes: elapsedMin, usage: getUsage(db, user.id, now).voiceMinutes, points: getBalance(db, user.id, now), notices: nudges };
  };

  app.post('/api/voice/sessions/:id/end', requireUser, async (c) => {
    const s = loadSession(c);
    if (!s) return c.json({ error: '見つかりません' }, 404);
    if (!s.ended_at) {
      await bill(s, c.get('user'));
      await endSession(s, 'user');
    }
    return c.json({ ok: true });
  });

  // 音声の中でキャラが道具を使った（データチャネルの function_call をブラウザが転送してくる）
  app.post('/api/voice/sessions/:id/tool', requireUser, async (c) => {
    const user = c.get('user');
    const s = loadSession(c);
    if (!s || s.ended_at) return c.json({ error: 'セッションが終了しています' }, 410);
    const { characterId, name, arguments: args } = await c.req.json().catch(() => ({}));
    if (!s.characterIds.includes(Number(characterId))) return c.json({ error: 'このセッションのキャラではありません' }, 400);
    const chara = loadReadableCharacter(characterId, user);
    try {
      return c.json(executeTool(db, { userId: user.id, chara, name, args }));
    } catch (err) {
      if (err instanceof ToolError) return c.json({ ok: false, error: err.message });
      throw err;
    }
  });

  // 発話の文字起こしを会話履歴に残す。ユーザの発話は安全チェックにもかける。
  app.post('/api/voice/sessions/:id/transcript', requireUser, async (c) => {
    const user = c.get('user');
    const s = loadSession(c);
    if (!s) return c.json({ error: '見つかりません' }, 404);
    const { role, characterId, text } = await c.req.json().catch(() => ({}));
    const content = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    if (!content || !['user', 'assistant'].includes(role)) return c.json({ error: '内容が正しくありません' }, 400);
    if (s.mode === 'interpret') return c.json({ ok: true, notices: [] }); // 通訳の内容は保存しない
    const targets = role === 'user' ? s.characterIds : [Number(characterId)].filter((id) => s.characterIds.includes(id));
    tx(db, () => {
      for (const cid of targets) {
        let conv = db.prepare('SELECT id FROM conversations WHERE user_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1').get(user.id, cid);
        conv ??= { id: Number(db.prepare('INSERT INTO conversations (user_id, character_id) VALUES (?, ?)').run(user.id, cid).lastInsertRowid) };
        db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conv.id, role, content);
      }
    });
    const notices = role === 'user' ? [checkUserText(db, { userId: user.id, characterId: s.characterIds[0], text: content })].filter(Boolean) : [];
    return c.json({ ok: true, notices });
  });

  // 声のお試し（キャラ作成・編集画面）
  app.post('/api/voice/preview', requireUser, async (c) => {
    const { voice, speed, text } = await c.req.json().catch(() => ({}));
    if (!VOICES.includes(voice)) return c.json({ error: '声が正しくありません' }, 400);
    const sample = typeof text === 'string' && text.trim() ? text.trim().slice(0, 120) : 'こんにちは。今日はどんな一日でしたか？';
    try {
      tx(db, () => chargeFor(db, { userId: c.get('user').id, feature: 'voice_generation' }));
    } catch (err) {
      if (err instanceof InsufficientPointsError || err instanceof PaymentRequiredError) return c.json({ error: 'ボイスの枠かポイントが足りません', code: 'payment_required' }, 402);
      throw err;
    }
    try {
      const audio = await realtime.speech({ text: sample, voice, speed: Number(speed) || 1 });
      return c.body(audio, 200, { 'Content-Type': 'audio/mpeg' });
    } catch (err) {
      if (err instanceof RealtimeError) return c.json({ error: '音声を作れませんでした' }, 502);
      throw err;
    }
  });
}

// ハートビートが途切れた（タブを閉じた・回線が切れた）セッションを切る。サーバで1分ごとに呼ぶ。
export async function sweepVoiceSessions(db, realtime, now = new Date()) {
  const cutoff = sqlTime(new Date(now.getTime() - VOICE_LIMITS.heartbeatTimeoutSec * 1000));
  const stale = db.prepare('SELECT * FROM voice_sessions WHERE ended_at IS NULL AND last_heartbeat_at < ?').all(cutoff);
  for (const s of stale) {
    db.prepare(`UPDATE voice_sessions SET ended_at = ?, end_reason = 'heartbeat_timeout' WHERE id = ?`).run(sqlTime(now), s.id);
    if (realtime) await Promise.allSettled(JSON.parse(s.call_ids).map((id) => realtime.hangup(id)));
  }
  return stale.length;
}
