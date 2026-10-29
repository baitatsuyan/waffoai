import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- ユーザごとのサブスク。status: pending（初回支払い待ち）/ active / canceled（期間末まで有効）/ closed。
-- pending_* は支払い待ちの新しい申し込み。初回の支払いが確認できたら plan / interval に反映する。
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  plan TEXT NOT NULL,
  interval TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'canceled', 'closed')),
  subscription_request TEXT UNIQUE,
  subscription_id TEXT,
  pending_request TEXT UNIQUE,
  pending_plan TEXT,
  pending_interval TEXT,
  current_period_no INTEGER,
  current_period_start TEXT,
  current_period_end TEXT
);

-- ポイント購入の注文（Waffo の単発決済）。
CREATE TABLE IF NOT EXISTS payments (
  payment_request_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pack TEXT NOT NULL,
  amount_jpy INTEGER NOT NULL,
  points INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'closed', 'refunded', 'chargeback')),
  acquiring_order_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 期間内の利用回数。period_key は 'day:2026-10-29' や 'cycle:<period_start>'。
CREATE TABLE IF NOT EXISTS usage_counters (
  user_id INTEGER NOT NULL REFERENCES users(id),
  feature TEXT NOT NULL,
  period_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, feature, period_key)
);

-- ポイントの付与ロット。有償(paid)と無償(free)を分けて残高管理する（資金決済法対応）。
CREATE TABLE IF NOT EXISTS point_lots (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('paid', 'free')),
  amount INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, source_ref)
);

-- ポイント消費履歴。1回の消費が複数ロットにまたがることがある。
CREATE TABLE IF NOT EXISTS point_spends (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lot_id INTEGER NOT NULL REFERENCES point_lots(id),
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  feature TEXT NOT NULL,
  character_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  world_setting TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  opening TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  chat_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  character_id INTEGER NOT NULL REFERENCES characters(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- クリエイター報酬（単位 R）。available_at を過ぎるまで出金不可（返金・チャージバック対策の保留期間）。
CREATE TABLE IF NOT EXISTS creator_rewards (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  character_id INTEGER NOT NULL REFERENCES characters(id),
  amount_r REAL NOT NULL,
  available_at TEXT NOT NULL,
  payout_id INTEGER REFERENCES payouts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  amount_r REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'paid', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 返金・チャージバックによるポイント失効。reason（返金IDなど）で重複処理を防ぐ。
CREATE TABLE IF NOT EXISTS point_revocations (
  reason TEXT PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES point_lots(id),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lots_user ON point_lots(user_id, remaining);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_characters_vis ON characters(visibility, chat_count);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// BEGIN IMMEDIATE で書き込みロックを先に取り、ポイント二重消費などを防ぐ。
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// SQLite の datetime('now') と同じ 'YYYY-MM-DD HH:MM:SS'（UTC）形式。
export function sqlTime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
