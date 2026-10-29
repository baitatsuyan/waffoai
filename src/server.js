import { serve } from '@hono/node-server';
import { env } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createWaffoClient } from './billing/waffo.js';

const db = openDb(env.dbPath);
const waffo = createWaffoClient();
const app = createApp({ db, waffo });

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`Waffo listening on http://localhost:${info.port}`);
  if (!env.llmBaseUrl) console.log('LLM_BASE_URL 未設定: モック返答で動作します');
  if (!waffo) console.log('Waffo の鍵が未設定: 決済は使えません（WAFFO_API_KEY など）');
  else console.log(`Waffo: ${env.waffoEnvironment} 環境に接続します`);
});
