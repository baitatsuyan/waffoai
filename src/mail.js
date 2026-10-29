import { env } from './config.js';

// ログインリンクのメール送信（Resend）。鍵がなければ null を返し、呼び出し側が扱いを決める。
export function createMailer({ apiKey = env.resendApiKey, from = env.mailFrom, fetchImpl = fetch } = {}) {
  if (!apiKey || !from) return null;
  return async function sendMail({ to, subject, text }) {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`mail send failed: ${res.status} ${await res.text().catch(() => '')}`);
  };
}

export function loginMail(link) {
  return {
    subject: 'AIボウのログインリンク',
    text: `下のリンクからログインしてください（15分間有効）。\n\n${link}\n\n心当たりがない場合は、このメールを破棄してください。`,
  };
}
