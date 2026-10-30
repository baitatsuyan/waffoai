import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env, IMAGE_LIMITS } from '../config.js';
import { currentUser } from '../auth.js';
import { PERSONAS } from '../personas.js';
import { OFFICIAL, officialOwnerId } from '../seed.js';
import { OFFICIAL_LOOKS, TEMPLATE_LOOKS } from '../gallery.js';
import { dailyCounter, clientIp } from './demo.js';
import { imageDir, IMAGE_FILE, portraitPrompt, generatePortraits, ImageError, PORTRAIT_STYLES } from '../images.js';

const TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

export function imageRoutes(app, {
  db, requireUser, generate = generatePortraits, dir = imageDir(), limits = IMAGE_LIMITS, counter = dailyCounter(),
  isAdmin = (user) => env.adminEmails.includes(user.email),
}) {
  app.get('/images/:file', async (c) => {
    const file = c.req.param('file');
    if (!IMAGE_FILE.test(file) || !existsSync(join(dir, file))) return c.notFound();
    return c.body(await readFile(join(dir, file)), 200, {
      'Content-Type': TYPES[file.split('.').pop()],
      'Cache-Control': file.startsWith('tpl-') ? 'public, max-age=3600' : 'public, max-age=31536000, immutable',
    });
  });

  // 相棒づくり：見た目の説明から立ち絵の候補をつくる（ログイン前でも使える）
  app.post('/api/make/portraits', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const user = currentUser(c, db);
    const key = user ? `user:${user.id}` : `ip:${clientIp(c)}`;
    const max = user ? limits.perUser : limits.perIp;
    if (!counter(key, max) || !counter('total', limits.total)) {
      return c.json({ error: user ? '絵づくりは今日はここまでです。また明日お試しください' : '登録前の絵づくりは今日はここまでです。無料登録すると続けてつくれます', code: 'image_limit' }, 429);
    }
    const prompt = portraitPrompt({
      name: String(body.name ?? '').slice(0, 50),
      persona: PERSONAS[body.persona] ? body.persona : 'chat',
      looks: String(body.looks ?? '').trim().slice(0, 300),
      profile: String(body.profile ?? '').trim(),
      style: PORTRAIT_STYLES[body.style] ? body.style : 'anime',
    });
    try {
      const images = await generate({ prompt, n: limits.candidates, userKey: key, dir });
      return c.json({ images });
    } catch (err) {
      if (err instanceof ImageError) return c.json({ error: err.message, code: err.code }, err.code === 'moderation_blocked' ? 400 : 502);
      throw err;
    }
  });

  // 運営用：公式の相棒とギャラリーの絵をまとめてつくる（時間がかかるので裏で進め、状態を返す）
  const job = { running: false, done: 0, total: 0, errors: [] };
  const requireAdmin = async (c, next) => {
    if (!isAdmin(c.get('user'))) return c.json({ error: '運営用の機能です' }, 403);
    await next();
  };
  app.get('/api/admin/portraits', requireUser, requireAdmin, (c) => c.json(job));
  app.post('/api/admin/portraits', requireUser, requireAdmin, async (c) => {
    if (job.running) return c.json(job);
    const { force } = await c.req.json().catch(() => ({}));
    const owner = officialOwnerId(db);
    const tasks = [];
    for (const o of OFFICIAL) {
      const row = db.prepare('SELECT id, image FROM characters WHERE creator_id = ? AND name = ?').get(owner ?? -1, o.name);
      if (!row || !OFFICIAL_LOOKS[o.name] || (row.image && !force)) continue;
      tasks.push(async () => {
        const [url] = await generate({ prompt: portraitPrompt({ name: o.name, persona: o.persona, looks: OFFICIAL_LOOKS[o.name], profile: o.profile }), n: 1, dir });
        db.prepare('UPDATE characters SET image = ? WHERE id = ?').run(url, row.id);
      });
    }
    for (const [slug, t] of Object.entries(TEMPLATE_LOOKS)) {
      const file = `tpl-${slug}.webp`;
      if (existsSync(join(dir, file)) && !force) continue;
      tasks.push(() => generate({ prompt: portraitPrompt(t), n: 1, fileNames: [file], dir }));
    }
    Object.assign(job, { running: true, done: 0, total: tasks.length, errors: [] });
    runAll(tasks, 3, job).finally(() => { job.running = false; });
    return c.json(job, 202);
  });
}

async function runAll(tasks, concurrency, job) {
  const queue = [...tasks];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const task = queue.shift();
      try { await task(); } catch (err) { job.errors.push(err.message); }
      job.done++;
    }
  }));
}
