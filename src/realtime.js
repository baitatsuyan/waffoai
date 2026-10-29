import { createHash } from 'node:crypto';
import { env } from './config.js';
import { buildInstructions } from './prompt.js';
import { realtimeToolDefs } from './tools.js';

// OpenAI Realtime API との接続。ブラウザの WebRTC の SDP をサーバが受け取り、
// セッション設定（指示文・声・ツール）を付けて /v1/realtime/calls に送る（unified interface）。
// API キーはブラウザに渡さず、返ってきた call_id で、残高切れや時間切れのときにサーバから通話を切れる。

const API = 'https://api.openai.com/v1';

export class RealtimeError extends Error {}

export function createRealtimeClient({ apiKey = env.openaiApiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) return null;
  const auth = { Authorization: `Bearer ${apiKey}` };
  return {
    async createCall({ sdp, session, safetyId }) {
      const form = new FormData();
      form.set('sdp', sdp);
      form.set('session', JSON.stringify(session));
      const res = await fetchImpl(`${API}/realtime/calls`, {
        method: 'POST', headers: { ...auth, 'OpenAI-Safety-Identifier': safetyId }, body: form, signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new RealtimeError(`realtime call failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const callId = res.headers.get('location')?.split('/').pop() ?? null;
      return { answer: await res.text(), callId };
    },
    async hangup(callId) {
      const res = await fetchImpl(`${API}/realtime/calls/${encodeURIComponent(callId)}/hangup`, { method: 'POST', headers: auth, signal: AbortSignal.timeout(10_000) });
      // すでに終わっている通話は 404 などになるが、切れていればよい
      return res.ok;
    },
    // 同時通訳は翻訳専用セッション。短い有効期限のクライアント用キーを発行する。
    async createTranslationSecret({ language, safetyId }) {
      const res = await fetchImpl(`${API}/realtime/translations/client_secrets`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'OpenAI-Safety-Identifier': safetyId },
        body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 60 }, session: { model: env.translateModel, audio: { output: { language } } } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new RealtimeError(`translation secret failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      return { value: data.value, expiresAt: data.expires_at };
    },
    // 声のお試し再生（キャラ作成時の声選び）
    async speech({ text, voice, speed = 1, instructions }) {
      const res = await fetchImpl(`${API}/audio/speech`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.ttsModel, input: text, voice, speed, instructions, response_format: 'mp3' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new RealtimeError(`speech failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// 個人を特定しない安定した識別子（OpenAI の不正利用対策用）
export const safetyIdFor = (userId) => createHash('sha256').update(`aibow:${userId}`).digest('hex').slice(0, 32);

// 1対1：マイク音声を直接キャラに聞かせる speech-to-speech。割り込み（話し始めたら止まる）はモデル側の VAD で行う。
export function directSession(db, chara, userId) {
  return {
    type: 'realtime',
    model: env.realtimeModel,
    instructions: buildInstructions(db, chara, { userId, mode: 'voice' }),
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: env.transcribeModel },
        turn_detection: { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
      },
      output: { voice: chara.voice || 'marin', speed: chara.voice_speed || 1 },
    },
    tools: realtimeToolDefs(chara),
    tool_choice: 'auto',
  };
}

// グループの「耳」：マイク音声を聞き取って文字にするだけ。自分では返答しない。
// 話し始め（speech_started）を合図に、話しているキャラを止める（割り込み）。
export function earSession() {
  return {
    type: 'realtime',
    model: env.realtimeModel,
    instructions: 'あなたは聞き取り専用です。返答はしません。',
    output_modalities: ['text'],
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: env.transcribeModel },
        turn_detection: { type: 'server_vad', silence_duration_ms: 500, create_response: false, interrupt_response: false },
      },
    },
  };
}

// グループの「声」：キャラごとに声の違うセッションを持つ。マイクは聞かせず、
// ブラウザが聞き取った文字と他のキャラの発言を渡して、順番に話させる。
export function voiceSession(db, chara, userId, members) {
  return {
    type: 'realtime',
    model: env.realtimeModel,
    instructions: buildInstructions(db, chara, { userId, members, mode: 'voice' }),
    audio: {
      input: { turn_detection: null },
      output: { voice: chara.voice || 'marin', speed: chara.voice_speed || 1 },
    },
    tools: realtimeToolDefs(chara),
    tool_choice: 'auto',
  };
}
