import { serve } from '@hono/node-server';
import { env } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const db = openDb(env.dbPath);
const app = createApp({ db });

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`Waffo listening on http://localhost:${info.port}`);
  if (!env.llmBaseUrl) console.log('LLM_BASE_URL 未設定: モック返答で動作します');
  if (!env.stripeSecretKey) console.log('STRIPE_SECRET_KEY 未設定: 決済画面は使えません');
});
