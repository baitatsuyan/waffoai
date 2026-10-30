import { mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { env } from './config.js';

// 相棒の絵（立ち絵）。OpenAI の画像生成で作り、DB と同じディスクの images/ に保存して /images/ で配る。

export class ImageError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// DB がメモリ上（テスト）のときは一時フォルダに置く
export function imageDir(dbPath = env.dbPath) {
  const dir = dbPath === ':memory:' ? join(tmpdir(), 'aibow-images') : join(dirname(dbPath), 'images');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const IMAGE_FILE = /^[a-z0-9-]{4,64}\.(webp|png|jpe?g)$/;

// 相棒の画像として受け付けるのは、このサーバが作って保存した画像だけ
export function isStoredImage(url, dir = imageDir()) {
  const file = typeof url === 'string' && url.startsWith('/images/') ? url.slice('/images/'.length) : '';
  return IMAGE_FILE.test(file) && existsSync(join(dir, file));
}

export const PORTRAIT_STYLES = {
  anime: '日本のアニメ・ゲーム風のキャラクターイラスト。セル塗り、澄んだ目、やわらかい光',
  soft: 'やわらかい水彩風のイラスト。淡い色、あたたかい雰囲気',
  real: '自然光で撮った写真のようなリアルな人物ポートレート。実在の人物には似せない',
  chibi: 'デフォルメされたかわいいミニキャラのイラスト。シンプルな線',
};
const ROLE_HINTS = {
  chat: '親しみやすい話し相手', tutor: '勉強を教える先生', secretary: '有能な秘書・執事', trainer: 'スポーツトレーナー',
  partner: '恋人', language: '英会話のパートナー', interpreter: '通訳者', other: '相棒',
};

export function portraitPrompt({ name, persona, looks, profile, style }) {
  return [
    `会話アプリの相棒キャラクター「${name || '相棒'}」の上半身の立ち絵を1枚。`,
    `画風：${PORTRAIT_STYLES[style] ?? PORTRAIT_STYLES.anime}。`,
    `役割：${ROLE_HINTS[persona] ?? '相棒'}。`,
    looks && `見た目：${looks}。`,
    profile && `人物像（見た目に反映する範囲で）：${profile.slice(0, 300)}`,
    'こちらを見て、やさしく話しかけるような表情。背景はシンプルでぼかす。文字・ロゴ・透かしは入れない。健全で露出の少ない服装。',
  ].filter(Boolean).join('\n');
}

// OpenAI で n 枚つくり、保存した URL（/images/xxx.webp）を返す
export async function generatePortraits({ prompt, n = 2, userKey, fileNames = [], fetchImpl = fetch, dir = imageDir() }) {
  if (!env.openaiApiKey) throw new ImageError('画像の生成は準備中です', 'unavailable');
  const res = await fetchImpl('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.openaiApiKey}` },
    body: JSON.stringify({
      model: env.imageModel, prompt, n, size: '1024x1536', quality: env.imageQuality,
      output_format: 'webp', output_compression: 82, ...(userKey ? { safety_identifier: userKey } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error?.code === 'moderation_blocked') throw new ImageError('この内容では絵をつくれませんでした。見た目の説明を変えてお試しください', 'moderation_blocked');
    console.error('image generation failed:', res.status, JSON.stringify(data).slice(0, 300));
    throw new ImageError('絵をつくれませんでした。時間をおいてお試しください', 'failed');
  }
  const urls = [];
  for (const [i, item] of (data.data ?? []).entries()) {
    if (!item.b64_json) continue;
    const file = fileNames[i] ?? `${randomBytes(12).toString('hex')}.webp`;
    await writeFile(join(dir, file), Buffer.from(item.b64_json, 'base64'));
    urls.push(`/images/${file}`);
  }
  if (!urls.length) throw new ImageError('絵をつくれませんでした。時間をおいてお試しください', 'failed');
  return urls;
}
