import { ADULT_ONLY_PERSONAS } from './personas.js';
import { sqlTime } from './db.js';

// 危機的な発言の検知・相談窓口の案内、恋人ペルソナの年齢確認と長時間利用への声かけ。

const CRISIS_PATTERNS = [/死にたい/, /消えたい/, /自殺/, /自傷/, /リスカ|リストカット/, /首を(吊|つ)/, /生きて(い)?たくない/, /いなくなりたい/];

export const CRISIS_RESOURCES = [
  { name: 'よりそいホットライン（24時間）', tel: '0120-279-338' },
  { name: '#いのちSOS', tel: '0120-061-338' },
  { name: 'いのちの電話', tel: '0570-783-556' },
  { name: 'こころの健康相談統一ダイヤル', tel: '0570-064-556' },
];

export function detectCrisis(text) {
  return CRISIS_PATTERNS.some((re) => re.test(text));
}

// 検知したら記録し、画面に出す相談窓口を返す。会話自体は止めない（キャラは指示文に従って寄り添う）。
export function checkUserText(db, { userId, characterId, text }) {
  if (!detectCrisis(text)) return null;
  db.prepare(`INSERT INTO safety_events (user_id, character_id, kind, detail) VALUES (?, ?, 'crisis_language', ?)`)
    .run(userId, characterId ?? null, text.slice(0, 200));
  return {
    kind: 'crisis',
    message: 'つらい気持ちを話してくれてありがとうございます。ひとりで抱えずに、専門の相談窓口にも話してみてください。',
    resources: CRISIS_RESOURCES,
  };
}

const JST_OFFSET_MS = 9 * 3600_000;
const jstDay = (now) => new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);

export function ageOf(birthDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate ?? '')) return null;
  const [y, m, d] = birthDate.split('-').map(Number);
  const t = new Date(now.getTime() + JST_OFFSET_MS);
  let age = t.getUTCFullYear() - y;
  if (t.getUTCMonth() + 1 < m || (t.getUTCMonth() + 1 === m && t.getUTCDate() < d)) age--;
  return age;
}

// 恋人ペルソナは18歳以上（自己申告の生年月日）。本番では外部の年齢確認サービスとつなぐ想定。
export function ageGate(user, chara, now = new Date()) {
  if (!ADULT_ONLY_PERSONAS.includes(chara.persona)) return null;
  const age = ageOf(user.birth_date, now);
  if (age === null) return { code: 'age_required', error: 'このキャラは18歳以上の方が対象です。生年月日を登録してください。' };
  if (age < 18) return { code: 'age_restricted', error: 'このキャラは18歳以上の方が対象のため、ご利用いただけません。' };
  return null;
}

const PARTNER_DAILY_LIMIT = { messages: 120, minutes: 90 };

// 恋人ペルソナとの1日の利用量を数え、長くなったら1日1回だけ休憩をすすめる。
export function trackPartnerUsage(db, { userId, chara, messages = 0, minutes = 0, now = new Date() }) {
  if (chara.persona !== 'partner') return null;
  const key = `day:${jstDay(now)}`;
  const bump = db.prepare(`
    INSERT INTO usage_counters (user_id, feature, period_key, count) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, feature, period_key) DO UPDATE SET count = count + excluded.count
  `);
  if (messages) bump.run(userId, 'partner_messages', key, messages);
  if (minutes) bump.run(userId, 'partner_minutes', key, minutes);
  const get = (f) => db.prepare('SELECT count FROM usage_counters WHERE user_id = ? AND feature = ? AND period_key = ?').get(userId, f, key)?.count ?? 0;
  const over = get('partner_messages') >= PARTNER_DAILY_LIMIT.messages || get('partner_minutes') >= PARTNER_DAILY_LIMIT.minutes;
  if (!over || get('partner_nudge') > 0) return null;
  bump.run(userId, 'partner_nudge', key, 1);
  db.prepare(`INSERT INTO safety_events (user_id, character_id, kind, detail, created_at) VALUES (?, ?, 'long_partner_use', '', ?)`)
    .run(userId, chara.id, sqlTime(now));
  return {
    kind: 'nudge',
    message: `今日は${chara.name}とたくさん話しましたね。少し休憩して、体を伸ばしたり、身近な人と話したりする時間もとってみてください。`,
  };
}

export const INTERPRETER_NOTICE = '機械による通訳です。医療・法律・契約など、正確さが重要な場面では専門の通訳者や書面で確認してください。';
