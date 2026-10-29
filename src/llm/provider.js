import { env } from '../config.js';

// キャラ設定から system プロンプトを組み立てる。設定は毎回同じ文字列になるよう並べ、
// プロバイダ側のプロンプトキャッシュが効くようにする（入力トークン原価の削減）。
export function buildSystemPrompt(chara) {
  return [
    'あなたは以下の設定のキャラクターとして、ユーザとの創作上の会話（ロールプレイ）を行います。',
    'キャラクターになりきって返答し、設定にない事実を断定しないでください。',
    'ナレーションは *アスタリスク* で囲み、台詞はそのまま書きます。1回の返答は300字程度までにします。',
    '',
    `# キャラクター名\n${chara.name}`,
    chara.world_setting && `# 基本設定（舞台・ユーザの立場）\n${chara.world_setting}`,
    chara.profile && `# プロフィール\n${chara.profile}`,
  ].filter(Boolean).join('\n\n');
}

// OpenAI 互換の Chat Completions API を叩く。OpenRouter、BytePlus ModelArk、DeepSeek、
// vLLM で自前ホストしたモデルなど、ベース URL を変えるだけで仕入れ先を切り替えられる。
export async function generateReply({ chara, history }) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(chara) },
    ...(chara.opening ? [{ role: 'assistant', content: chara.opening }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  if (!env.llmBaseUrl || !env.llmApiKey) return mockReply(chara, history);

  const res = await fetch(`${env.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.llmApiKey}` },
    body: JSON.stringify({ model: env.llmModel, messages, max_tokens: 600, temperature: 0.9 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM API returned an empty reply');
  return { text, usage: data.usage ?? null };
}

// API キー未設定時の開発用。課金や画面の動作確認に使う。
function mockReply(chara, history) {
  const last = history.at(-1)?.content ?? '';
  return {
    text: `*${chara.name}は少し考えてから口を開いた*\n「${last.slice(0, 40)}」……なるほどね。（開発用モック返答です。LLM_BASE_URL と LLM_API_KEY を設定すると実際のモデルが応答します）`,
    usage: null,
  };
}
