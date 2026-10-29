import { serve } from '@hono/node-server';
import { env } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createWaffoClient } from './billing/waffo.js';
import { createRealtimeClient } from './realtime.js';
import { generateText } from './llm/provider.js';
import { runProactive, setupPush } from './proactive.js';
import { sweepVoiceSessions } from './routes/voice.js';
import { ensureOfficialCharacters } from './seed.js';

const db = openDb(env.dbPath);
ensureOfficialCharacters(db);
const waffo = createWaffoClient();
const realtime = createRealtimeClient();
const pushReady = setupPush();
const app = createApp({ db, waffo, realtime });

// 毎分：キャラからのメッセージ送信と、途切れた音声通話の後始末
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await runProactive(db, { generateText });
    await sweepVoiceSessions(db, realtime);
  } catch (err) {
    console.error('scheduler failed:', err);
  } finally {
    running = false;
  }
}, 60_000).unref();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`Waffo listening on http://localhost:${info.port}`);
  if (!env.llmBaseUrl) console.log('LLM_BASE_URL 未設定: モック返答で動作します');
  if (!realtime) console.log('OPENAI_API_KEY 未設定: 音声トークは使えません（文字のみ）');
  if (!pushReady) console.log('VAPID 鍵が未設定: キャラからのメッセージは受信箱のみ（プッシュ通知なし）');
  if (!waffo) console.log('Waffo の鍵が未設定: 決済は使えません（WAFFO_API_KEY など）');
  else console.log(`Waffo: ${env.waffoEnvironment} 環境に接続します`);
});
