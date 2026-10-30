import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureOfficialCharacters } from '../src/seed.js';
import { imageRoutes } from '../src/routes/images.js';
import { dailyCounter } from '../src/routes/demo.js';
import { portraitPrompt, imageDir, ImageError } from '../src/images.js';

function setup({ generate, limits = { perIp: 2, perUser: 3, total: 10, candidates: 2 } } = {}) {
  const db = openDb(':memory:');
  ensureOfficialCharacters(db);
  const dir = mkdtempSync(join(tmpdir(), 'aibow-img-'));
  const calls = [];
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user', { id: 1, email: 'admin@example.com' }); await next(); });
  imageRoutes(app, {
    db, dir, limits, counter: dailyCounter(), requireUser: async (_c, next) => next(), isAdmin: () => true,
    generate: generate ?? (async ({ prompt, n, fileNames = [] }) => {
      calls.push({ prompt, n });
      return Array.from({ length: n }, (_, i) => {
        const file = fileNames[i] ?? `img${calls.length}x${i}.webp`;
        writeFileSync(join(dir, file), 'webp');
        return `/images/${file}`;
      });
    }),
  });
  const post = (path, body, ip = '1.1.1.1') => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body ?? {}) });
  return { db, app, dir, calls, post };
}

test('絵の候補をつくって保存し、/images/ で配る。ログイン前は IP ごとの上限', async () => {
  const { app, calls, post } = setup();
  const r = await post('/api/make/portraits', { name: 'ハル', persona: 'secretary', looks: '黒髪のロング、紺のスーツ', style: 'anime' });
  assert.equal(r.status, 200);
  const { images } = await r.json();
  assert.equal(images.length, 2);
  assert.match(calls[0].prompt, /ハル/);
  assert.match(calls[0].prompt, /黒髪のロング/);
  assert.match(calls[0].prompt, /アニメ/);
  const img = await app.request(images[0]);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  assert.equal((await app.request('/images/..%2Fsecret.webp')).status, 404);
  assert.equal((await post('/api/make/portraits', {})).status, 200);
  assert.equal((await (await post('/api/make/portraits', {})).json()).code, 'image_limit');
  assert.equal((await post('/api/make/portraits', {}, '2.2.2.2')).status, 200);
});

test('つくれなかったとき（内容で断られた）は理由を返す', async () => {
  const { post } = setup({ generate: async () => { throw new ImageError('この内容では絵をつくれませんでした', 'moderation_blocked'); } });
  const r = await post('/api/make/portraits', { looks: 'x' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'moderation_blocked');
});

test('運営用：公式の相棒とギャラリーの絵をまとめてつくる', async () => {
  const { db, app, dir, post } = setup();
  const start = await post('/api/admin/portraits');
  assert.equal(start.status, 202);
  let job;
  for (let i = 0; i < 50; i++) {
    job = await (await app.request('/api/admin/portraits')).json();
    if (!job.running) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(job.total, 18);
  assert.equal(job.done, 18);
  assert.deepEqual(job.errors, []);
  assert.match(db.prepare(`SELECT image FROM characters WHERE name = 'ミサキ'`).get().image, /^\/images\//);
  assert.ok(existsSync(join(dir, 'tpl-haru.webp')));
  // つくり済みのものは作り直さない
  await post('/api/admin/portraits');
  assert.equal((await (await app.request('/api/admin/portraits')).json()).total, 0);
});

test('相棒の画像は、このサーバが保存した画像だけ受け付ける', async () => {
  const db = openDb(':memory:');
  const app = createApp({ db, isProduction: false });
  const file = 'testimg01.webp';
  writeFileSync(join(imageDir(), file), 'webp');
  const base = { persona: 'chat', name: 'ハル', voice: 'marin', voice_speed: 1 };
  assert.equal((await app.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', character: { ...base, image: 'https://evil.example/x.png' } }) })).status, 400);
  assert.equal((await app.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', character: { ...base, image: '/images/nothere1.webp' } }) })).status, 400);
  const ok = await app.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', character: { ...base, image: `/images/${file}` } }) });
  const link = new URL((await ok.json()).devLink);
  const v = await app.request(link.pathname + link.search);
  const id = Number(v.headers.get('location').match(/welcome=(\d+)/)[1]);
  assert.equal(db.prepare('SELECT image FROM characters WHERE id = ?').get(id).image, `/images/${file}`);
});

test('立ち絵の指示文：画風・役割・見た目を入れ、文字やロゴを入れないよう指示する', () => {
  const p = portraitPrompt({ name: '黒崎', persona: 'secretary', looks: '燕尾服', style: 'real' });
  assert.match(p, /黒崎/);
  assert.match(p, /写真/);
  assert.match(p, /燕尾服/);
  assert.match(p, /文字・ロゴ/);
});
