// サービス全体の料金・上限設定。数値はここだけで管理する。

export const env = {
  port: Number(process.env.PORT ?? 3000),
  // Render では RENDER_EXTERNAL_URL（https://xxx.onrender.com）が自動で入る。独自ドメインにしたら BASE_URL で上書きする
  baseUrl: process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000',
  dbPath: process.env.DB_PATH ?? 'data/aibow.db',
  // LLM: OpenAI 互換 API（OpenRouter / BytePlus ModelArk / DeepSeek など）。未設定ならモック。
  llmBaseUrl: process.env.LLM_BASE_URL ?? '',
  llmApiKey: process.env.LLM_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL ?? '',
  // 決済（決済代行：Waffo）。鍵は Waffo Dashboard の Integration で発行・登録する。
  waffoApiKey: process.env.WAFFO_API_KEY ?? '',
  waffoPrivateKey: process.env.WAFFO_PRIVATE_KEY ?? '',
  waffoPublicKey: process.env.WAFFO_PUBLIC_KEY ?? '',
  waffoMerchantId: process.env.WAFFO_MERCHANT_ID ?? '',
  waffoEnvironment: process.env.WAFFO_ENV ?? 'sandbox',
  // リアルタイム音声（OpenAI Realtime API）。未設定なら音声トークは使えず、文字のみ。
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  realtimeModel: process.env.REALTIME_MODEL ?? 'gpt-realtime-2.1',
  transcribeModel: process.env.TRANSCRIBE_MODEL ?? 'gpt-live-transcribe',
  translateModel: process.env.TRANSLATE_MODEL ?? 'gpt-realtime-translate',
  ttsModel: process.env.TTS_MODEL ?? 'gpt-4o-mini-tts',
  // Web Push（キャラからのメッセージ通知）。npx web-push generate-vapid-keys で作る。
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:support@example.com',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  mailFrom: process.env.MAIL_FROM ?? '',

  adminEmails: (process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

// サブスクプラン。messagesPerPeriod を超えた分はポイントで払う。
// resetPeriod: 'day' は日次リセット、'billing_cycle' は契約期間ごと。
export const PLANS = {
  free: { name: 'Free', priceJpy: { month: 0 }, messagesPerPeriod: 10, voicePerPeriod: 5, resetPeriod: 'day', voiceMinutesPerPeriod: 3, monthlyPoints: 0 },
  plus: { name: 'Plus', priceJpy: { month: 980, year: 10000 }, messagesPerPeriod: 3000, voicePerPeriod: 1500, resetPeriod: 'billing_cycle', voiceMinutesPerPeriod: 120, monthlyPoints: 300 },
  premium: { name: 'Premium', priceJpy: { month: 1500, year: 15000 }, messagesPerPeriod: 6000, voicePerPeriod: 3000, resetPeriod: 'billing_cycle', voiceMinutesPerPeriod: 300, monthlyPoints: 600 },
  pro: { name: 'Pro', priceJpy: { month: 3000, year: 30000 }, messagesPerPeriod: 30000, voicePerPeriod: 7500, resetPeriod: 'billing_cycle', voiceMinutesPerPeriod: 1000, monthlyPoints: 1500 },
};

// ポイント商品（有償ポイント）。1pt = 1円を基準に、高額パックほどボーナスを付ける。
export const POINT_PACKS = {
  p300: { priceJpy: 300, points: 300 },
  p500: { priceJpy: 500, points: 510 },
  p1000: { priceJpy: 1000, points: 1030 },
  p3000: { priceJpy: 3000, points: 3150 },
  p5000: { priceJpy: 5000, points: 5300 },
  p10000: { priceJpy: 10000, points: 11000 },
};

// 1回あたりの消費ポイント（プラン上限を超えた場合や、上限のない機能）。
// voice_minute はリアルタイム音声1分（グループ会話は参加キャラ数ぶん）。
export const POINT_COSTS = {
  chat_message: 1,
  voice_generation: 1,
  voice_minute: 10,
  image_generation: 20,
};

// リアルタイム音声の上限。1回の通話の最長時間と、ハートビートが途切れたら切るまでの時間。
export const VOICE_LIMITS = {
  maxCallMinutes: 60,
  heartbeatTimeoutSec: 90,
  maxGroupMembers: 4,
};

export const SIGNUP_BONUS_POINTS = 50;
// 無償ポイント（ボーナス・特典）の有効期限。有償ポイントは期限なし。
export const FREE_POINT_TTL_DAYS = 180;

// クリエイター還元：自作キャラで消費された「有償ポイント」の何％を報酬 R として積むか。
export const CREATOR_REWARD = {
  paidPointShare: 0.2,
  holdDays: 30,
  minPayoutR: 1000,
};

// 会話履歴として LLM に送る直近メッセージ数（トークン原価を抑える）。
export const CHAT_HISTORY_LIMIT = 30;
