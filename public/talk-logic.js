// トークの進行ルール（DOM に依存しない。テストからも読み込む）。

// 呼び名：「ユイ先生」は「ユイ」でも、「シオンさん」でも呼べる
export function callNames(name) {
  const base = name.replace(/(先生|さん|くん|ちゃん)$/, '');
  return [...new Set([name, base])].filter((n) => n.length > 0);
}

// 誰が答えるか。名前を呼ばれたキャラ → 「みんな」なら全員 → 1人なら本人 → 直前に話したキャラ → 全員。
export function pickResponders(text, members, lastId = null) {
  const called = members.filter((m) => callNames(m.name).some((n) => text.includes(n)));
  if (called.length) {
    // 呼ばれた順に答える
    return called.sort((a, b) => firstIndex(text, a) - firstIndex(text, b));
  }
  if (/みんな|全員|皆さん|みなさん/.test(text) || members.length === 1) return members;
  const last = members.find((m) => m.id === lastId);
  return last ? [last] : members;
}

function firstIndex(text, m) {
  return Math.min(...callNames(m.name).map((n) => text.indexOf(n)).filter((i) => i >= 0));
}

// 呼びかけ部分（「シオン、」）を本文から外す。キャラに渡すのは用件だけ。
export function stripCall(text, member) {
  const names = callNames(member.name).sort((a, b) => b.length - a.length).map(escape).join('|');
  return text.replace(new RegExp(`(^|[、。\\s])(${names})(さん|先生)?[、,，\\s]*`), '$1').trim() || text;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
