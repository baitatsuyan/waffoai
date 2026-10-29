import { env } from '../config.js';

const MAX_TOOL_ROUNDS = 3;

// OpenAI 互換の Chat Completions API を叩く。OpenRouter、BytePlus ModelArk、DeepSeek、
// vLLM で自前ホストしたモデルなど、ベース URL を変えるだけで仕入れ先を切り替えられる。
// tools を渡すと function calling を行い、runTool で実行した結果を返して続きを生成する。
export async function generateReply({ instructions, history, opening, tools = [], runTool }) {
  const messages = [
    { role: 'system', content: instructions },
    ...(opening ? [{ role: 'assistant', content: opening }] : []),
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  if (!env.llmBaseUrl || !env.llmApiKey) return mockReply(history);

  const toolEvents = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const offerTools = tools.length > 0 && round < MAX_TOOL_ROUNDS;
    const data = await chatCompletion({ messages, ...(offerTools ? { tools, tool_choice: 'auto' } : {}) });
    const msg = data.choices?.[0]?.message ?? {};
    const calls = msg.tool_calls ?? [];
    if (!calls.length || !runTool) {
      const text = msg.content?.trim();
      if (!text) throw new Error('LLM API returned an empty reply');
      return { text, toolEvents, usage: data.usage ?? null };
    }
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const result = runTool(call.function?.name, call.function?.arguments);
      toolEvents.push({ name: call.function?.name, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  throw new Error('tool rounds exceeded');
}

// 1回だけの短い生成（キャラからの朝のメッセージ、調整の試し話など）
export async function generateText({ instructions, prompt }) {
  if (!env.llmBaseUrl || !env.llmApiKey) return `（開発用モック）${prompt.slice(0, 40)}`;
  const data = await chatCompletion({ messages: [{ role: 'system', content: instructions }, { role: 'user', content: prompt }] });
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM API returned an empty reply');
  return text;
}

async function chatCompletion(body) {
  const res = await fetch(`${env.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.llmApiKey}` },
    body: JSON.stringify({ model: env.llmModel, ...samplingParams(), ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// OpenAI の推論モデルは max_tokens と temperature を受け付けないため、出力上限の名前を変え、考える量を指定する。
// 上限には考える分も含まれるので多めに取る。
function samplingParams() {
  if (env.llmIsOpenAI) return { max_completion_tokens: 2000, ...(env.llmReasoningEffort ? { reasoning_effort: env.llmReasoningEffort } : {}) };
  return { max_tokens: 600, temperature: 0.9 };
}

// API キー未設定時の開発用。課金や画面の動作確認に使う。
function mockReply(history) {
  const last = history.at(-1)?.content ?? '';
  return {
    text: `「${last.slice(0, 40)}」……なるほどね。（開発用モック返答です。LLM_BASE_URL と LLM_API_KEY を設定すると実際のモデルが応答します）`,
    toolEvents: [],
    usage: null,
  };
}
