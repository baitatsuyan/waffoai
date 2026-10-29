// 依存なしの小さな SPA。ハッシュでルーティングし、DOM は h() で組み立てる（innerHTML は使わない）。

import { VoiceTalk } from './voice.js';
import { pickResponders, stripCall } from './talk-logic.js';
import { landingPage as renderLanding } from './landing.js';

const view = document.getElementById('view');
let me = null;
let meta = null; // 役割・声の一覧
let currentTalk = null; // 通話中の VoiceTalk（ページを離れたら切る）

// replaceChildren に false / null を渡すと文字として出るため、取り除いてから渡す
function put(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

const yen = (n) => `${n.toLocaleString()}円`;
const personaLabel = (c) => (c.persona === 'other' ? (c.role || 'その他').slice(0, 20) : meta?.personas[c.persona]?.label ?? '');
const initial = (name) => [...name][0] ?? '?';

async function refreshMe() {
  me = await api('/api/me');
  meta ??= await api('/api/personas');
  const nav = document.getElementById('nav-links');
  const acc = document.getElementById('account');
  const here = location.hash.split('?')[0] || '#/';
  const link = (href, label) => h('a', { href, 'aria-current': here === href ? 'page' : false }, label);
  if (!me.user) {
    put(nav, link('#/discover', 'さがす'), link('#/login', 'ログイン'));
    put(acc, h('a', { class: 'button small', href: '#/make' }, '無料ではじめる'));
    return;
  }
  put(nav, link('#/', 'マイページ'), link('#/discover', 'さがす'), link('#/talk', 'トーク'), link('#/notes', 'ノート'), link('#/settings', '設定'));
  const inbox = await api('/api/inbox').catch(() => ({ unread: 0 }));
  put(acc, h('a', { href: '#/inbox', 'aria-label': `お知らせ ${inbox.unread}件` }, 'お知らせ', inbox.unread ? h('span', { class: 'badge' }, String(inbox.unread)) : null),
    h('button', { class: 'secondary small', onclick: logout }, 'ログアウト'));
}

// ログアウトしたらメインページへ
async function logout() {
  if (currentTalk) { currentTalk.stop(); currentTalk = null; }
  await api('/auth/logout', { method: 'POST' });
  location.hash = '#/';
  route();
}

function usageLine() {
  if (!me?.user) return '';
  const u = me.usage.chat;
  const v = me.usage.voiceMinutes;
  const reset = me.usage.plan === 'free' ? '毎日リセット' : '契約期間ごと';
  return `${me.usage.plan.toUpperCase()}プラン ・ 会話 ${u.used}/${u.limit} ・ 音声 ${v.used}/${v.limit}分（${reset}） ・ ポイント ${me.points.total}pt`;
}

// 相談窓口・休憩のすすめ・エラーなどのお知らせ
function noticeBox(n) {
  return h('div', { class: `notice ${n.kind ?? 'info'}`, role: n.kind === 'crisis' ? 'alert' : 'status' },
    h('p', {}, n.message),
    n.resources && h('ul', {}, n.resources.map((r) => h('li', {}, `${r.name}：`, h('span', { class: 'tel' }, r.tel)))));
}

// 恋人ペルソナなど、年齢確認が必要なときの入力欄
function birthDateForm(onDone) {
  const input = h('input', { type: 'date', max: new Date().toISOString().slice(0, 10) });
  const msg = h('p');
  return h('div', { class: 'section' },
    h('p', {}, 'このキャラは18歳以上の方が対象です。生年月日を登録してください。'),
    h('div', { class: 'row' }, input, h('button', { onclick: async () => {
      try { await api('/api/me/birth-date', { method: 'POST', body: { birthDate: input.value } }); onDone(); }
      catch (err) { put(msg, h('span', { class: 'error' }, err.message)); }
    } }, '登録')), msg);
}

// ---- 画面：さがす ----

const characterCard = (c) => h('a', { class: 'card', href: `#/c/${c.id}` },
  h('div', { class: 'card-head' }, h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), h('h3', {}, c.name)),
  h('div', {}, c.tagline),
  h('div', { class: 'tags' }, c.persona !== 'chat' && h('span', { class: 'chip' }, personaLabel(c)), ` ${c.official ? '公式' : `by ${c.creator}`}`));

async function discoverPage(params) {
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'popular';
  const { characters } = await api(`/api/characters?sort=${sort}&q=${encodeURIComponent(q)}`);
  const search = h('input', { placeholder: 'キャラ名・タグで検索', value: q });
  const go = (s) => { location.hash = `#/discover?q=${encodeURIComponent(search.value)}&sort=${s}`; };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(sort); });
  const official = characters.filter((c) => c.official);
  const community = characters.filter((c) => !c.official);
  return [
    h('h1', {}, 'さがす'),
    h('p', { class: 'muted' }, '気に入った相手を「相棒」にすると、ホームからすぐ話せます。ぴったりの相手がいなければ、', h('a', { href: '#/make' }, '自分だけの相棒をつくる'), 'こともできます。'),
    h('div', { class: 'row' }, search,
      h('button', { class: sort === 'popular' ? '' : 'secondary', onclick: () => go('popular') }, '人気'),
      h('button', { class: sort === 'new' ? '' : 'secondary', onclick: () => go('new') }, '新着')),
    official.length > 0 && [h('h2', {}, '公式の相棒'), h('div', { class: 'grid' }, official.map(characterCard))],
    community.length > 0 && [h('h2', {}, 'みんなのキャラ'), h('div', { class: 'grid' }, community.map(characterCard))],
    !characters.length && h('p', { class: 'muted' }, q ? `「${q}」に一致するキャラはいません。` : 'まだキャラがありません。'),
  ];
}

// ---- 画面：はじめての人（ログイン前） ----

// 登録前につくった相棒の下書き。登録画面へ渡し、送信時にサーバへ預ける（メールを別の端末で開いても引き継げる）。
const DRAFT_KEY = 'aibow:draft';
let draftMemo = null;
function loadDraft() {
  if (!draftMemo) { try { draftMemo = JSON.parse(sessionStorage.getItem(DRAFT_KEY)); } catch { draftMemo = null; } }
  return draftMemo;
}
function saveDraft(d) { draftMemo = d; try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* 保存できなくてもメモリに残る */ } }
function clearDraft() { draftMemo = null; try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* なにもしない */ } }

// 読み上げ。ログイン前はお試し用（回数制限あり）、ログイン後は通常の声（枠・ポイントを使う）。失敗したらエラー文を返す。
async function playSpeech({ voice, speed = 1, text }) {
  const res = await fetch(me?.user ? '/api/voice/preview' : '/api/demo/speech', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice, speed, text }),
  });
  if (!res.ok) return (await res.json().catch(() => ({}))).error ?? '再生できませんでした';
  try { await new Audio(URL.createObjectURL(await res.blob())).play(); } catch { return '再生できませんでした'; }
  return null;
}

// ---- 画面：メインページ（ログイン前） ----

function landingPage() {
  return renderLanding({ h, put, api, me, MAKE_ROLES, VOICE_LABELS, playSpeech, demoPanel, saveDraft });
}

// メインページのお試し会話。キャラごとに会話を保ち、切り替えても続きから話せる。
function demoPanel({ characters, voiceAvailable }) {
  const logs = new Map(characters.map((c) => [c.id, []]));
  let current = characters[0];
  let busy = false;
  const tabs = h('div', { class: 'demo-tabs', role: 'tablist' });
  const chat = h('div', { class: 'chat demo-chat' });
  const chips = h('div', { class: 'chips' });
  const notice = h('div');
  const input = h('input', { placeholder: '話しかけてみる', maxlength: 300 });
  const sendBtn = h('button', {}, '送信');

  const bubble = (c, role, text) => h('div', { class: `bubble ${role}` }, text,
    role === 'assistant' && voiceAvailable && h('button', { class: 'mini', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const err = await playSpeech({ voice: c.voice, speed: c.voice_speed, text });
      if (err) put(notice, h('p', { class: 'muted small' }, err));
      btn.disabled = false;
    } }, '▶ 声で聞く'));
  const render = () => {
    put(tabs, characters.map((c) => h('button', { role: 'tab', class: 'demo-tab', 'aria-selected': c === current ? 'true' : 'false', onclick: () => { current = c; render(); } },
      h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), h('span', {}, h('b', {}, c.name), h('small', {}, personaLabel(c))))));
    const log = logs.get(current.id);
    put(chat, h('p', { class: 'muted small demo-tagline' }, current.tagline), bubble(current, 'assistant', current.opening),
      log.map((m) => m.role === 'cta' ? m.node : bubble(current, m.role, m.content)));
    put(chips, current.prompts.map((p) => h('button', { class: 'chip-btn', disabled: busy, onclick: () => send(p) }, p)));
    sendBtn.disabled = busy;
    chat.scrollTop = chat.scrollHeight;
  };
  const cta = () => h('div', { class: 'demo-cta' },
    h('p', {}, `${current.name}みたいな相棒を、あなた好みにつくれます。登録すると、話したことを覚えて予定や記録も残せます。`),
    h('a', { class: 'button', href: `#/make?persona=${current.persona}` }, `${personaLabel(current)}の相棒をつくる`));
  const send = async (text) => {
    text = text.trim();
    if (!text || busy) return;
    const c = current;
    const log = logs.get(c.id);
    log.push({ role: 'user', content: text });
    busy = true;
    input.value = '';
    put(notice);
    render();
    try {
      const r = await api('/api/demo/chat', { method: 'POST', body: { characterId: c.id, history: log.filter((m) => m.role !== 'cta') } });
      log.push({ role: 'assistant', content: r.text });
      if (log.filter((m) => m.role === 'user').length === 2) log.push({ role: 'cta', node: cta() });
    } catch (err) {
      log.pop();
      if (err.status === 429) log.push({ role: 'cta', node: h('div', { class: 'demo-cta' }, h('p', {}, err.message), h('a', { class: 'button', href: '#/make' }, '自分だけの相棒をつくる')) });
      else put(notice, h('p', { class: 'error' }, err.message));
    } finally {
      busy = false;
      render();
    }
  };
  sendBtn.addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(input.value); });
  render();
  return h('div', { class: 'demo-box' }, tabs, chat, chips, h('div', { class: 'composer' }, input, sendBtn), notice);
}

// ---- 画面：ホーム（わたしの相棒） ----

const WEEKDAY = '日月火水木金土';
const jstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000);
const whenLabel = (dueAt) => {
  const d = jstDate(new Date(`${dueAt.replace(' ', 'T')}Z`));
  const today = jstDate().toISOString().slice(0, 10);
  const tomorrow = jstDate(new Date(Date.now() + 86400_000)).toISOString().slice(0, 10);
  const day = d.toISOString().slice(0, 10);
  const label = day === today ? '今日' : day === tomorrow ? '明日' : `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY[d.getUTCDay()]}）`;
  return `${label} ${d.toISOString().slice(11, 16)}`;
};

async function homePage(params) {
  if (!me.user) return landingPage();
  const home = await api('/api/home');
  if (!home.companions.length) return onboardingPage();
  const welcomeId = Number(params.get('welcome'));
  const made = welcomeId ? home.companions.find((c) => c.id === welcomeId) : null;
  if (welcomeId) { clearDraft(); history.replaceState(null, '', '#/'); }
  const greet = (() => {
    const hour = jstDate().getUTCHours();
    return hour < 5 ? 'こんばんは' : hour < 11 ? 'おはようございます' : hour < 18 ? 'こんにちは' : 'こんばんは';
  })();
  const d = jstDate();
  const companions = home.companions;
  const startChat = async (c, btn) => {
    btn.disabled = true;
    try {
      const { id } = await api(`/api/characters/${c.id}/conversations/latest`, { method: 'POST' });
      location.hash = `#/chat/${id}`;
    } catch (err) {
      btn.disabled = false;
      location.hash = `#/c/${c.id}`;
    }
  };
  const talkable = companions.filter((c) => c.persona !== 'interpreter');
  const welcome = made && h('section', { class: 'panel welcome' },
    h('div', { class: 'card-head' }, h('span', { class: `avatar big p-${made.persona}` }, initial(made.name)),
      h('div', {}, h('h1', {}, `ようこそ${me.user.nickname ? `、${me.user.nickname}さん` : ''}！`),
        h('p', { class: 'muted' }, `${made.name}（${personaLabel(made)}）があなたを待っていました。さっそく話しかけてみましょう。`))),
    h('div', { class: 'row' },
      made.persona === 'interpreter'
        ? h('a', { class: 'button big', href: `#/talk?ids=${made.id}` }, '通訳をはじめる')
        : [h('a', { class: 'button big', href: `#/talk?ids=${made.id}` }, '声で話す'), h('button', { class: 'secondary', onclick: (e) => startChat(made, e.currentTarget) }, '文字で話す')]),
    h('ul', { class: 'tips' },
      h('li', {}, h('b', {}, 'トーク'), '：声でも文字でも話せます。名前を呼べば、複数の相棒と同時に話せます。'),
      h('li', {}, h('b', {}, 'ノート'), '：相棒が覚えたことや、登録した予定・記録が見られます。'),
      h('li', {}, h('b', {}, 'お知らせ'), '：相棒からの朝・夜のメッセージや、予定のお知らせが届きます。')));
  return [
    welcome,
    h('section', { class: 'greeting' },
      h('p', { class: 'muted' }, `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEKDAY[d.getUTCDay()]}）`),
      h('h1', {}, `${greet}${me.user.nickname ? `、${me.user.nickname}さん` : ''}`),
      h('div', { class: 'row' },
        talkable[0] && h('a', { class: 'button big', href: `#/talk?ids=${talkable[0].id}` }, `${talkable[0].name}に話しかける`),
        talkable.length > 1 && h('a', { class: 'button secondary', href: `#/talk?ids=${talkable.slice(0, 4).map((c) => c.id).join(',')}` }, 'みんなで話す'))),
    home.inbox.latest.length > 0 && h('section', { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', {}, '届いたメッセージ'), h('a', { href: '#/inbox' }, `すべて見る${home.inbox.unread ? `（未読 ${home.inbox.unread}）` : ''}`)),
      h('div', { class: 'messages' }, home.inbox.latest.map((m) => h('a', { class: `message${m.read_at ? '' : ' unread'}`, href: '#/inbox' },
        h('b', {}, m.character_name), ' ', m.text)))),
    h('section', { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', {}, '今日と明日'), h('a', { href: '#/notes?tab=event' }, 'ノートを見る')),
      home.upcoming.length
        ? h('ul', { class: 'list' }, home.upcoming.map((r) => h('li', {},
          h('span', { class: 'when' }, r.type === 'event' ? whenLabel(r.due_at) : `${r.data.due_date ?? ''}まで`),
          h('span', {}, r.type === 'event' ? r.data.title : `タスク：${r.data.title}`),
          h('span', { class: 'muted' }, `（${r.character_name}）`))))
        : h('p', { class: 'muted' }, '予定やタスクはありません。秘書に「明日10時に歯医者」と話しかけると登録されます。')),
    h('div', { class: 'row spread' }, h('h2', {}, 'わたしの相棒'), h('span', {}, h('a', { href: '#/make' }, '＋ つくる'), '　', h('a', { href: '#/discover' }, 'さがす'))),
    h('div', { class: 'grid' }, companions.map((c) => h('div', { class: 'card companion' },
      h('a', { class: 'card-head', href: `#/c/${c.id}` }, h('span', { class: `avatar p-${c.persona}` }, initial(c.name)),
        h('div', {}, h('h3', {}, c.name, c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null), h('div', { class: 'tags' }, personaLabel(c)))),
      h('p', { class: 'last' }, c.last_message ? c.last_message.slice(0, 60) : c.tagline),
      h('div', { class: 'row' },
        h('a', { class: 'button small', href: `#/talk?ids=${c.id}` }, c.persona === 'interpreter' ? '通訳' : '声で話す'),
        c.persona !== 'interpreter' && h('button', { class: 'secondary small', onclick: (e) => startChat(c, e.currentTarget) }, '文字で話す'))))),
    h('p', { class: 'status' }, usageLine(), ' ', h('a', { href: '#/billing' }, 'プラン')),
  ];
}

// はじめての人：公式の相棒から選んでもらう
async function onboardingPage() {
  const { suggested } = await api('/api/companions');
  const picked = new Set(suggested.filter((c) => ['secretary', 'tutor'].includes(c.persona)).map((c) => c.id));
  const grid = h('div', { class: 'grid' });
  const render = () => put(grid, suggested.map((c) => h('button', {
    class: 'card pick', 'aria-pressed': picked.has(c.id) ? 'true' : 'false',
    onclick: () => { picked.has(c.id) ? picked.delete(c.id) : picked.add(c.id); render(); },
  }, h('div', { class: 'card-head' }, h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), h('div', {}, h('h3', {}, c.name), h('div', { class: 'tags' }, personaLabel(c)))),
  h('p', {}, c.tagline))));
  render();
  const msg = h('p');
  const start = async (btn) => {
    if (!picked.size) { put(msg, h('span', { class: 'error' }, '1人以上選んでください')); return; }
    btn.disabled = true;
    for (const id of picked) await api('/api/companions', { method: 'POST', body: { characterId: id } });
    const ids = [...picked].filter((id) => suggested.find((c) => c.id === id)?.persona !== 'interpreter').slice(0, 4);
    location.hash = ids.length ? `#/talk?ids=${ids[0]}` : '#/';
  };
  return [
    h('section', { class: 'greeting' },
      h('h1', {}, 'ようこそ。まずは相棒を迎えましょう'),
      h('p', { class: 'muted' }, '相棒はあなたの予定や好きなものを覚えて、話すほど合ってきます。あとから何人でも増やせます。')),
    h('section', { class: 'panel' },
      h('h2', {}, '自分だけの相棒をつくる'),
      h('p', { class: 'muted' }, '役割（先生・秘書・トレーナー・恋人など）を選んで、名前・性格・話し方・声を決められます。あなただけが話せる相棒です。'),
      h('a', { class: 'button big', href: '#/make' }, 'つくる')),
    h('h2', {}, 'または、公式の相棒から選ぶ'),
    grid, msg,
    h('p', {}, h('button', { class: 'secondary', onclick: (e) => start(e.currentTarget) }, 'この相棒ではじめる')),
  ];
}

// ---- 画面：キャラ詳細 ----

async function characterPage(id) {
  const { character: c } = await api(`/api/characters/${id}`);
  const msg = h('div');
  const startChat = async () => {
    if (!me.user) { location.hash = '#/login'; return; }
    try {
      const { id: convId } = await api(`/api/characters/${c.id}/conversations/latest`, { method: 'POST' });
      location.hash = `#/chat/${convId}`;
    } catch (err) {
      if (err.data?.code === 'age_required') put(msg, birthDateForm(startChat));
      else put(msg, h('p', { class: 'error' }, err.message));
    }
  };
  const isOwner = me.user?.id === c.creator_id;
  const toggleCompanion = async () => {
    if (!me.user) { location.hash = '#/login'; return; }
    try {
      if (c.companion) await api(`/api/companions/${c.id}`, { method: 'DELETE' });
      else await api('/api/companions', { method: 'POST', body: { characterId: c.id } });
      route();
    } catch (err) { put(msg, h('p', { class: 'error' }, err.message)); }
  };
  return [
    h('div', { class: 'card-head' }, h('span', { class: `avatar big p-${c.persona}` }, initial(c.name)),
      h('div', {}, h('h1', {}, c.name), h('div', { class: 'tags' }, c.persona !== 'chat' && h('span', { class: 'chip' }, personaLabel(c)), ` ${c.official ? '公式' : `by ${c.creator}`}`))),
    h('p', {}, c.tagline),
    h('div', { class: 'row' },
      me.user
        ? h('a', { class: 'button big', href: `#/talk?ids=${c.id}` }, c.persona === 'interpreter' ? '通訳をはじめる' : '声で話す')
        : h('a', { class: 'button big', href: '#/login' }, 'はじめる'),
      me.user && c.persona !== 'interpreter' && h('button', { class: 'secondary', onclick: startChat }, '文字で話す'),
      me.user && h('button', { class: 'secondary', onclick: toggleCompanion }, c.companion ? '相棒から外す' : '相棒にする'),
      isOwner && (c.visibility === 'private'
        ? h('a', { class: 'button secondary', href: `#/make/${c.id}` }, '名前・性格・声を変える')
        : h('a', { class: 'button secondary', href: `#/creator/edit/${c.id}` }, 'クリエイター画面で編集'))),
    msg,
    c.persona === 'other' && c.role && [h('h2', {}, '役割'), h('div', { class: 'section' }, c.role)],
    c.world_setting && [h('h2', {}, '基本設定'), h('div', { class: 'section' }, c.world_setting)],
    c.profile && [h('h2', {}, 'プロフィール'), h('div', { class: 'section' }, c.profile)],
    c.opening && [h('h2', {}, '最初のひとこと'), h('div', { class: 'section' }, c.opening)],
    me.user && c.persona !== 'interpreter' && await tweakCard(c, 'personal'),
    me.user && c.companion && c.persona !== 'interpreter' && await proactiveCard(c),
  ];
}

// 調整：プロンプトで性格・話し方を微修正。作成者は公開中の調整、それ以外は自分用の調整。
const TWEAK_CHIPS = ['返答はもっと短く', '敬語で話す', 'タメ口で話す', '関西弁で話す', 'もっと褒めて', '厳しめに', '質問を多めに', '絵文字を使わない'];

async function tweakCard(c, scope) {
  const t = await api(`/api/characters/${c.id}/tweaks`);
  const isPublic = scope === 'creator';
  const area = h('textarea', { maxlength: 1000, placeholder: '例：語尾を「〜だぜ」にする／返答は1文で／敬語をやめる' });
  area.value = isPublic ? t.creator : t.personal;
  const out = h('div');
  const save = async () => {
    try { await api(`/api/characters/${c.id}/tweaks`, { method: 'PUT', body: { scope, text: area.value } }); route(); }
    catch (err) { put(out, h('p', { class: 'error' }, err.message)); }
  };
  const compare = async (btn) => {
    btn.disabled = true;
    put(out, h('p', { class: 'muted' }, '調整前と調整後の返答を作っています…'));
    try {
      const r = await api(`/api/characters/${c.id}/tweaks/compare`, { method: 'POST', body: { text: area.value } });
      put(out, h('div', { class: 'compare' },
        h('div', {}, h('div', { class: 'label' }, 'いまの調整'), h('div', { class: 'section' }, r.before)),
        h('div', {}, h('div', { class: 'label' }, '新しい調整'), h('div', { class: 'section' }, r.after))));
    } catch (err) { put(out, h('p', { class: 'error' }, err.message)); }
    btn.disabled = false;
  };
  const versions = t.versions.filter((v) => v.scope === scope);
  return h('section', { class: 'panel' },
    h('h2', {}, isPublic ? '性格・話し方の調整（公開中のキャラに反映）' : `${c.name}をあなた好みに`),
    h('p', { class: 'muted' }, isPublic
      ? 'プロンプト（指示文）でキャラの性格や返答の仕方を微調整します。会話する全員に反映されます。'
      : '話し方や距離感を、あなたとの会話だけ調整できます。たとえば「返答はもっと短く」「タメ口で」など。'),
    h('div', { class: 'chips' }, TWEAK_CHIPS.map((x) => h('button', { class: 'chip-btn', onclick: () => {
      area.value = area.value.trim() ? `${area.value.trim()}／${x}` : x;
    } }, x))),
    area,
    h('div', { class: 'row' }, h('button', { onclick: save }, '保存'), h('button', { class: 'secondary', onclick: (e) => compare(e.currentTarget) }, '試しに比べる（会話2回分）')),
    out,
    versions.length > 0 && h('details', {}, h('summary', {}, `以前の調整（${versions.length}）`),
      h('ul', { class: 'list' }, versions.map((v) => h('li', {},
        h('span', {}, v.text || '（調整なし）'), h('span', { class: 'muted' }, ` ${v.created_at.slice(0, 16)} `),
        h('button', { class: 'secondary small', onclick: async () => { await api(`/api/characters/${c.id}/tweaks/revert`, { method: 'POST', body: { versionId: v.id } }); route(); } }, 'これに戻す'))))));
}

// キャラから届くメッセージの設定
async function proactiveCard(c) {
  const p = await api(`/api/characters/${c.id}/proactive`);
  const row = (kind, label) => {
    const on = h('input', { type: 'checkbox', checked: p[kind].enabled });
    const time = h('input', { type: 'time', value: p[kind].time });
    const save = () => api(`/api/characters/${c.id}/proactive`, { method: 'PUT', body: { [kind]: { enabled: on.checked, time: time.value } } });
    on.addEventListener('change', save);
    time.addEventListener('change', save);
    return h('label', { class: 'switch' }, on, label, time);
  };
  return h('section', { class: 'panel' },
    h('h2', {}, `${c.name}からのメッセージ`),
    h('p', { class: 'muted' }, '覚えていることや予定に合わせて、毎日メッセージが届きます。予定の30分前にはお知らせも届きます。'),
    row('morning', 'おはよう'), row('night', 'おやすみ'),
    h('p', {}, h('a', { href: '#/inbox' }, 'お知らせと通知の設定へ')));
}

// ---- 画面：文字チャット ----

async function chatPage(id) {
  const data = await api(`/api/conversations/${id}`);
  const list = h('div', { class: 'chat' });
  const notices = h('div');
  const addBubble = (role, text) => { list.append(h('div', { class: `bubble ${role}` }, text)); };
  const addEvent = (text) => { list.append(h('div', { class: 'bubble event' }, text)); };
  if (data.character.opening) addBubble('assistant', data.character.opening);
  for (const m of data.messages) addBubble(m.role, m.content);

  const status = h('div', { class: 'status' }, usageLine());
  const input = h('textarea', { placeholder: 'メッセージを入力（Ctrl+Enter で送信）', maxlength: 2000 });
  const send = h('button', {}, '送信');
  const TOOL_LABEL = { remember: '覚えました', add_event: '予定を登録しました', add_task: 'タスクを登録しました', complete_task: 'タスクを完了にしました', log_workout: 'トレーニングを記録しました', record_quiz: '小テストの結果を記録しました', add_flashcard: '単語カードに追加しました' };
  const submit = async () => {
    const content = input.value.trim();
    if (!content) return;
    send.disabled = true;
    addBubble('user', content);
    input.value = '';
    try {
      const r = await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { content } });
      for (const e of r.toolEvents) if (e.ok && TOOL_LABEL[e.name]) addEvent(`${data.character.name}が${TOOL_LABEL[e.name]}（ノートで確認できます）`);
      addBubble('assistant', r.message.content);
      put(notices, ...r.notices.map(noticeBox));
      await refreshMe();
      status.textContent = usageLine() + (r.charged.via === 'points' ? ` ・ 今回 ${r.charged.points}pt 消費` : '');
    } catch (err) {
      list.lastChild.remove();
      input.value = content;
      put(status, h('span', { class: 'error' }, err.message),
        err.status === 402 ? [' ', h('a', { href: '#/billing' }, 'プラン・ポイントを見る')] : null);
    } finally {
      send.disabled = false;
      window.scrollTo(0, document.body.scrollHeight);
    }
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight));
  return [
    h('div', { class: 'row spread' }, h('h1', {}, h('a', { href: `#/c/${data.character.id}` }, data.character.name)),
      h('a', { class: 'button', href: `#/talk?ids=${data.character.id}` }, '声で話す')),
    status, list, notices, h('div', { class: 'composer' }, input, send),
  ];
}

// ---- 画面：つくる・編集 ----

async function editPage(id) {
  if (!me.user) { location.hash = '#/login'; return []; }
  const c = id ? (await api(`/api/characters/${id}`)).character : { visibility: 'public', persona: 'chat', voice: 'marin', voice_speed: 1 };
  if (id && c.creator_id !== me.user.id) { location.hash = `#/c/${id}`; return []; }
  const PERSONA_HELP = {
    chat: '会話を楽しむキャラです。舞台や関係性をプロフィールに書きます。',
    trainer: 'メニュー作り・トレーニングの記録・自己ベストの把握ができます。あなたが決めるのは性格と口調です。',
    tutor: '学習計画・確認問題・分野ごとの正答率の記録ができます。',
    secretary: '話しかけるだけで予定・タスクを登録し、朝のメッセージや30分前のお知らせを届けます。',
    partner: '好きなものや予定を覚えて、朝夜のメッセージを届けます（18歳以上の方が対象）。',
    language: '英会話の相手。間違いをその場で直し、単語カードに追加します。',
    interpreter: '話した言葉をその場で訳して読み上げます。自分と相手の言語を切り替えて使います。',
    other: '一覧にない役割を自由に作れます。下の「役割の説明」に、何を手伝うキャラなのかを書いてください。',
  };
  const fields = {
    persona: h('select', {}, Object.entries(meta.personas).map(([k, p]) => h('option', { value: k, selected: c.persona === k }, p.label))),
    role: h('textarea', { maxlength: 400, placeholder: '例：旅行プランナー。予算と日数を聞いて、移動時間まで考えた行程を一緒に作る' }),
    name: h('input', { value: c.name ?? '', maxlength: 50 }),
    tagline: h('input', { value: c.tagline ?? '', maxlength: 200, placeholder: '例：閉館後の図書館で、返却されない本を探す司書に声をかけられる' }),
    world_setting: h('textarea', { maxlength: 4000, placeholder: '舞台、ユーザの立場、物語の前提' }),
    profile: h('textarea', { maxlength: 4000, placeholder: '年齢、口調、一人称、性格、ユーザとの距離感' }),
    opening: h('textarea', { maxlength: 2000, placeholder: '最初のひとこと' }),
    tags: h('input', { value: c.tags ?? '', maxlength: 200, placeholder: 'ファンタジー, 幼なじみ' }),
    visibility: h('select', {}, ['public', 'unlisted', 'private'].map((v) =>
      h('option', { value: v, selected: c.visibility === v }, { public: '公開', unlisted: '限定公開（URLを知る人だけ）', private: '非公開' }[v]))),
  };
  fields.role.value = c.role ?? '';
  fields.world_setting.value = c.world_setting ?? '';
  fields.profile.value = c.profile ?? '';
  fields.opening.value = c.opening ?? '';
  const help = h('p', { class: 'muted' });
  const roleWrap = h('div', {}, h('label', {}, '役割の説明'), fields.role);
  const updatePersona = () => {
    help.textContent = PERSONA_HELP[fields.persona.value];
    roleWrap.hidden = fields.persona.value !== 'other';
  };
  fields.persona.addEventListener('change', updatePersona);
  updatePersona();
  const voice = voiceFields(c, () => fields.opening.value);
  const msg = h('p');
  const save = async () => {
    const body = { ...Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value])), ...voice.values() };
    try {
      const r = id ? await api(`/api/characters/${id}`, { method: 'PUT', body }) : await api('/api/characters', { method: 'POST', body });
      location.hash = id ? '#/creator' : `#/creator/edit/${r.id}`;
    } catch (err) { put(msg, h('span', { class: 'error' }, err.message)); }
  };
  const field = (label, el) => [h('label', {}, label), el];
  return [
    h('p', {}, h('a', { href: '#/creator' }, '← クリエイター')),
    h('h1', {}, id ? `${c.name}を編集` : 'キャラをつくる'),
    h('p', { class: 'muted' }, '役割（基本ペルソナ）を選ぶと、その役割に必要な道具（記録・予定・単語カードなど）が自動で付きます。個性は自由に決められます。'),
    field('基本ペルソナ（役割）', fields.persona), help, roleWrap,
    field('キャラ名', fields.name),
    field('紹介文', fields.tagline),
    field('基本設定（舞台・ユーザの立場）', fields.world_setting),
    field('プロフィール（性格・口調）', fields.profile),
    field('最初のひとこと', fields.opening),
    voice.nodes,
    field('タグ（カンマ区切り）', fields.tags),
    field('公開範囲', fields.visibility),
    msg,
    h('p', {}, h('button', { onclick: save }, '保存'), ' ', id && h('a', { class: 'button secondary', href: `#/c/${id}` }, '公開ページを見る')),
    id && c.persona !== 'interpreter' && await tweakCard(c, 'creator'),
  ];
}

// 声と話す速さの入力欄（試しに聞くボタン付き）。キャラづくりの画面で共通。
const VOICE_LABELS = {
  marin: '女性・明るくやわらか', cedar: '男性・低めで落ち着いた', alloy: '中性的・おだやか', ash: '男性・はきはき', ballad: '男性・やさしい',
  coral: '女性・あたたかい', echo: '男性・すっきり', sage: '女性・落ち着いた', shimmer: '女性・はなやか', verse: '男性・表情ゆたか',
};
function voiceFields(c, sampleText) {
  const voice = h('select', {}, meta.voices.map((v) => h('option', { value: v, selected: c.voice === v }, VOICE_LABELS[v] ? `${VOICE_LABELS[v]}（${v}）` : v)));
  const speed = h('input', { type: 'range', min: '0.7', max: '1.3', step: '0.05', value: String(c.voice_speed ?? 1) });
  const speedLabel = h('span', { class: 'muted' });
  const updateSpeed = () => { speedLabel.textContent = ` ${Number(speed.value).toFixed(2)}倍`; };
  speed.addEventListener('input', updateSpeed);
  updateSpeed();
  const voiceMsg = h('span', { class: 'muted' });
  const preview = async () => {
    voiceMsg.textContent = '再生の準備中…';
    const err = await playSpeech({ voice: voice.value, speed: Number(speed.value), text: sampleText() || undefined });
    voiceMsg.textContent = err ?? 'AIが生成した音声です';
  };
  return {
    values: () => ({ voice: voice.value, voice_speed: Number(speed.value) }),
    nodes: [
      h('label', {}, '声'),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, voice), h('button', { class: 'secondary', onclick: preview }, '試しに聞く'), voiceMsg),
      h('label', {}, '話す速さ', speedLabel), speed,
    ],
  };
}

// ---- 画面：自分だけの相棒をつくる（一般ユーザー向け。非公開で作り、そのまま相棒に加える） ----

const MAKE_ROLES = {
  chat: ['話し相手', '雑談や相談の相手。あなたの話を覚えています'],
  trainer: ['トレーナー', 'メニュー作りとトレーニングの記録'],
  tutor: ['勉強の先生', '学習計画・確認問題・苦手の把握'],
  secretary: ['秘書', '予定とタスクを登録して、朝に段取りを伝える'],
  partner: ['恋人', '好きなものや予定を覚えて、朝夜にメッセージ（18歳以上）'],
  language: ['語学パートナー', '英会話の相手。間違いを直して単語カードに'],
  interpreter: ['通訳', '話した言葉をその場で訳して読み上げる'],
  other: ['その他', '役割を自分で決める'],
};
const PERSONALITY_CHIPS = ['やさしい', '明るい', 'クール', '落ち着いている', 'ちょっと厳しめ', '甘えん坊', 'おっとり', '面倒見がいい', 'ユーモアがある'];
const SPEECH_CHIPS = ['敬語', 'タメ口', '関西弁', '一人称は「わたし」', '一人称は「僕」', '一人称は「俺」', '返事は短め'];

// ログイン前でもつくれる。つくり終えたら下書きとして登録画面へ渡す。
async function makePage(id, params) {
  if (id && !me.user) { location.hash = '#/login'; return []; }
  const fresh = { persona: MAKE_ROLES[params?.get('persona')] ? params.get('persona') : 'chat', voice: 'marin', voice_speed: 1 };
  // ログイン前は作りかけの下書きを、ギャラリーから来たときはテンプレートを読み込む
  const c = id ? (await api(`/api/characters/${id}`)).character : ((!me.user || params?.get('from') === 'template') && loadDraft()) || fresh;
  if (id && c.creator_id !== me.user.id) { location.hash = `#/c/${id}`; return []; }
  let persona = c.persona;
  const roles = h('div', { class: 'grid roles' });
  const role = h('textarea', { maxlength: 400, placeholder: '例：旅行プランナー。予算と日数を聞いて、移動時間まで考えた行程を一緒に作る' });
  role.value = c.role ?? '';
  const roleWrap = h('div', {}, h('label', {}, '何を手伝ってもらう？'), role);
  const renderRoles = () => {
    put(roles, Object.entries(MAKE_ROLES).map(([k, [label, desc]]) => h('button', {
      class: 'card pick', 'aria-pressed': persona === k ? 'true' : 'false',
      onclick: () => { persona = k; renderRoles(); },
    }, h('h3', {}, label), h('p', { class: 'muted' }, desc))));
    roleWrap.hidden = persona !== 'other';
  };
  renderRoles();
  const name = h('input', { value: c.name ?? '', maxlength: 50, placeholder: '例：ハル' });
  const profile = h('textarea', { maxlength: 4000, placeholder: '例：28歳。明るくて面倒見がいい。タメ口で話す。落ち込んでいると気づいて声をかけてくれる' });
  profile.value = c.profile ?? '';
  const relation = h('textarea', { maxlength: 4000, placeholder: '例：わたしのことは「ゆうちゃん」と呼ぶ。大学時代からの友だちという設定' });
  relation.value = c.world_setting ?? '';
  const opening = h('textarea', { maxlength: 2000, placeholder: '例：おかえり！今日はどんな一日だった？' });
  opening.value = c.opening ?? '';
  const addChip = (text) => {
    profile.value = profile.value.trim() ? `${profile.value.trim()}。${text}` : text;
    profile.focus();
  };
  const chips = (list) => h('div', { class: 'chips' }, list.map((t) => h('button', { class: 'chip-btn', onclick: () => addChip(t) }, `＋${t}`)));
  const voice = voiceFields(c, () => opening.value);
  const msg = h('p');
  // おまかせ：役割・名前・いま書いてあるキーワードから、性格の文章と最初のひとことを書いてもらう
  const suggestMsg = h('span', { class: 'muted small' });
  const suggest = async (btn) => {
    btn.disabled = true;
    suggestMsg.textContent = '考えています…';
    try {
      const r = await api('/api/make/suggest', { method: 'POST', body: { persona, name: name.value, traits: profile.value, role: role.value } });
      profile.value = r.profile;
      if (!opening.value.trim()) opening.value = r.opening;
      suggestMsg.textContent = '書きました。自由に直してください。';
    } catch (err) { suggestMsg.textContent = err.message; }
    btn.disabled = false;
  };
  const save = async (btn) => {
    const body = {
      name: name.value.trim(), persona, role: role.value, profile: profile.value, world_setting: relation.value, opening: opening.value,
      tagline: c.tagline || `わたしだけの${MAKE_ROLES[persona][0]}`, tags: c.tags ?? '', visibility: c.visibility ?? 'private',
      ...voice.values(),
    };
    if (!body.name) { put(msg, h('span', { class: 'error' }, '名前を入れてください')); name.focus(); return; }
    if (persona === 'other' && !body.role.trim()) { put(msg, h('span', { class: 'error' }, '何を手伝ってもらうかを書いてください')); role.focus(); return; }
    if (!me.user) { saveDraft(body); location.hash = '#/signup'; return; }
    btn.disabled = true;
    try {
      if (id) {
        await api(`/api/characters/${id}`, { method: 'PUT', body });
        location.hash = `#/c/${id}`;
      } else {
        const r = await api('/api/characters', { method: 'POST', body });
        await api('/api/companions', { method: 'POST', body: { characterId: r.id } });
        location.hash = `#/talk?ids=${r.id}`;
      }
    } catch (err) {
      btn.disabled = false;
      put(msg, h('span', { class: 'error' }, err.message));
    }
  };
  const field = (label, el, note) => [h('label', {}, label), note && h('p', { class: 'muted small' }, note), el];
  return [
    h('h1', {}, id ? `${c.name}を変える` : '自分だけの相棒をつくる'),
    h('p', { class: 'muted' }, 'あなただけが話せる相棒です（ほかの人には見えません）。役割を選ぶと、予定・記録・単語カードなどの道具が自動で付きます。'),
    !me.user && h('ol', { class: 'progress' }, h('li', { class: 'on' }, '相棒をつくる'), h('li', {}, '無料登録'), h('li', {}, 'マイページで話す')),
    h('h2', {}, '1. 役割'), roles, roleWrap,
    h('h2', {}, '2. 名前と性格'),
    field('名前', name),
    field('性格・話し方', profile, '下のボタンで足すか、自由に書いてください。キーワードだけ入れて「おまかせ」でも書けます。'),
    chips(PERSONALITY_CHIPS), chips(SPEECH_CHIPS),
    h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: (e) => suggest(e.currentTarget) }, '✨ おまかせで書く'), suggestMsg),
    field('あなたとの関係・呼び方（なくてもOK）', relation),
    field('最初のひとこと（なくてもOK）', opening),
    h('h2', {}, '3. 声'), voice.nodes,
    msg,
    !me.user && h('p', { class: 'muted small' }, '最後に無料登録をすると、この相棒がマイページで待っています。'),
    h('p', {}, h('button', { class: 'big', onclick: (e) => save(e.currentTarget) }, id ? '保存する' : me.user ? 'この相棒と話してみる' : 'この相棒で登録する（無料）'),
      ' ', id && h('a', { class: 'button secondary', href: `#/c/${id}` }, 'やめる')),
  ];
}

// ---- 画面：トーク（声で話す） ----

async function talkPage(params) {
  if (!me.user) { location.hash = '#/login'; return []; }
  const { companions } = await api('/api/companions');
  const pool = [...companions];
  // 相棒でないキャラをキャラページから呼んだときも、その場で話せるようにする（話すと相棒に加わる）
  for (const id of (params.get('ids') ?? '').split(',').map(Number).filter(Boolean)) {
    if (!pool.some((c) => c.id === id)) {
      const r = await api(`/api/characters/${id}`).catch(() => null);
      if (r) pool.push(r.character);
    }
  }
  if (!pool.length) {
    return [h('h1', {}, 'トーク'), h('p', {}, 'まだ相棒がいません。'), h('a', { class: 'button big', href: '#/' }, '相棒を選ぶ')];
  }
  let selected = (params.get('ids') ?? '').split(',').map(Number).filter((id) => pool.some((c) => c.id === id)).slice(0, 4);
  if (!selected.length) selected = [pool.find((c) => c.persona !== 'interpreter')?.id ?? pool[0].id];

  const stage = h('div', { class: 'stage' });
  const log = h('div', { class: 'talk-log', 'aria-live': 'polite' });
  const notices = h('div');
  const controls = h('div', { class: 'talk-controls' });
  const usage = h('p', { class: 'muted' }, usageLine());
  const picker = h('div', { class: 'picker' });

  const members = () => selected.map((id) => pool.find((c) => c.id === id));
  const modeOf = () => (members().length === 1 && members()[0].persona === 'interpreter' ? 'interpret' : members().length === 1 ? 'direct' : 'group');

  const renderPicker = () => {
    put(picker, ...pool.map((c) => h('button', {
      class: 'member', 'aria-pressed': selected.includes(c.id) ? 'true' : 'false', disabled: Boolean(currentTalk),
      onclick: () => {
        if (selected.includes(c.id)) selected = selected.filter((x) => x !== c.id);
        else if (c.persona === 'interpreter' || members().some((m) => m.persona === 'interpreter')) selected = [c.id]; // 通訳は1人で
        else selected = [...selected, c.id].slice(-4);
        history.replaceState(null, '', `#/talk?ids=${selected.join(',')}`);
        renderPicker(); renderStage(); renderControls();
      },
    }, h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), c.name)));
  };

  const orbs = new Map();
  const renderStage = () => {
    orbs.clear();
    put(stage, ...(members().length ? members().map((c) => {
      const caption = h('div', { class: 'caption' });
      const orb = h('div', { class: `orb p-${c.persona}` }, h('span', {}, initial(c.name)));
      const wrap = h('div', { class: 'seat' }, orb, h('div', { class: 'seat-name' }, c.name, h('span', { class: 'muted' }, ` ${personaLabel(c)}`)), caption);
      orbs.set(c.id, { orb, caption, wrap });
      return wrap;
    }) : [h('p', { class: 'stage-empty' }, '話したいキャラを下から選んでください（4人まで）')]));
    const meOrb = h('div', { class: 'me-orb' }, h('span', {}, 'あなた'));
    orbs.set('me', { orb: meOrb, caption: h('div') });
    stage.append(meOrb);
  };

  const addLine = (role, text, id) => {
    const c = pool.find((x) => x.id === id);
    log.append(h('div', { class: `line ${role}` }, role === 'assistant' && h('b', {}, `${c?.name ?? ''}：`), text));
    log.scrollTop = log.scrollHeight;
  };

  const TOOL_LABEL = { remember: '覚えました', add_event: '予定を登録しました', add_task: 'タスクを登録しました', complete_task: 'タスクを完了にしました', log_workout: 'トレーニングを記録しました', record_quiz: '結果を記録しました', add_flashcard: '単語カードに追加しました' };

  // 通話していないときは文字で話す。誰が答えるかは声のときと同じルール（名前を呼ぶ／みんな／直前の相手）。
  const conversations = new Map(); // キャラ id → 会話 id
  let lastSpeaker = null;
  let chatting = false;
  let draft = ''; // 送れなかった文は入力欄に戻す
  const sendChat = async (text) => {
    if (chatting) return;
    chatting = true;
    renderControls();
    const group = members();
    addLine('user', text);
    try {
      for (const c of pickResponders(text, group, lastSpeaker)) {
        if (!conversations.has(c.id)) {
          conversations.set(c.id, (await api(`/api/characters/${c.id}/conversations/latest`, { method: 'POST' })).id);
        }
        const content = group.length > 1 ? stripCall(text, c) : text;
        const r = await api(`/api/conversations/${conversations.get(c.id)}/messages`, { method: 'POST', body: { content } });
        for (const e of r.toolEvents) if (e.ok && TOOL_LABEL[e.name]) log.append(h('div', { class: 'line event' }, `${c.name}が${TOOL_LABEL[e.name]}`));
        addLine('assistant', r.message.content, c.id);
        for (const n of r.notices) notices.prepend(noticeBox(n));
        lastSpeaker = c.id;
      }
      await refreshMe();
      usage.textContent = usageLine();
    } catch (err) {
      if (err.data?.code === 'age_required') put(notices, birthDateForm(() => sendChat(text)));
      else put(notices, noticeBox({ kind: 'error', message: err.message }), err.status === 402 ? h('a', { href: '#/billing' }, 'プラン・ポイントを見る') : null);
      draft = text;
    } finally {
      chatting = false;
      renderControls();
      controls.querySelector('.composer input')?.focus({ preventScroll: true }); // 続けて打てるように
    }
  };
  const chatComposer = () => {
    const input = h('input', { placeholder: members().length > 1 ? '文字で話す（名前を呼ぶとその相棒が答えます）' : '文字で話す', maxlength: 2000, disabled: chatting, value: draft });
    draft = '';
    const send = () => {
      const text = input.value.trim();
      if (!text || chatting) return;
      input.value = '';
      sendChat(text);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(); });
    return h('div', { class: 'composer' }, input, h('button', { disabled: chatting, onclick: send }, chatting ? '返事を待っています…' : '送信'));
  };

  const onUpdate = (e) => {
    if (e.type === 'line') addLine(e.role, e.text, e.id);
    else if (e.type === 'caption') { const o = orbs.get(e.id); if (o) o.caption.textContent = e.text; }
    else if (e.type === 'speaking') {
      for (const [id, o] of orbs) o.wrap?.classList.toggle('speaking', id === e.id);
      if (e.id) { const o = orbs.get(e.id); if (o) o.caption.textContent = ''; }
    } else if (e.type === 'listening') orbs.get('me')?.orb.classList.toggle('active', e.on);
    else if (e.type === 'tool' && e.ok) log.append(h('div', { class: 'line event' }, `${pool.find((c) => c.id === e.id)?.name}が${TOOL_LABEL[e.name] ?? e.name}`));
    else if (e.type === 'notice') notices.prepend(noticeBox(e));
    else if (e.type === 'usage') usage.textContent = `通話 ${e.minutes}分 ・ 音声 ${e.usage.used}/${e.usage.limit}分 ・ ポイント ${e.points.total}pt`;
    else if (e.type === 'status') {
      if (e.status === 'ended') {
        const reasons = { payment_required: '音声の無料枠とポイントを使い切ったため終了しました。', max_duration: '1回の通話の上限（60分）になったため終了しました。', heartbeat_timeout: '接続が途切れたため終了しました。' };
        if (reasons[e.reason]) notices.prepend(noticeBox({ kind: 'info', message: reasons[e.reason] }));
        currentTalk = null;
        refreshMe().then(() => { renderPicker(); renderControls(); });
      }
      renderControls();
    }
  };

  // 話している人の声の大きさに合わせて光らせる
  const animate = () => {
    if (!view.contains(stage)) return;
    for (const [id, o] of orbs) o.orb.style.setProperty('--level', String(currentTalk?.level(id) ?? 0));
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);

  const start = async (btn) => {
    btn.disabled = true;
    put(notices, );
    const talk = new VoiceTalk({ mode: modeOf(), members: members(), onUpdate });
    currentTalk = talk;
    renderPicker();
    try {
      await talk.start();
    } catch (err) {
      currentTalk = null;
      await talk.stop('error', { remote: false }).catch(() => {});
      if (err.data?.code === 'age_required') put(notices, birthDateForm(() => start(btn)));
      else if (err.name === 'NotAllowedError') put(notices, noticeBox({ kind: 'error', message: 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。' }));
      else put(notices, noticeBox({ kind: 'error', message: err.message }), err.status === 402 ? h('a', { href: '#/billing' }, 'プラン・ポイントを見る') : null);
      renderPicker();
    }
    btn.disabled = false;
    renderControls();
  };

  const renderControls = () => {
    const live = currentTalk && !currentTalk.ended;
    if (!live) {
      const canChat = members().length > 0 && modeOf() !== 'interpret';
      put(controls, 
        h('button', { class: 'big talk-start', disabled: !members().length || !meta.voiceAvailable || chatting, onclick: (e) => start(e.currentTarget) },
          modeOf() === 'interpret' ? '通訳をはじめる' : '声で話しはじめる'),
        !meta.voiceAvailable && h('p', { class: 'muted' }, '音声は準備中です。下の入力欄から文字で話せます。'),
        members().length > 1 && h('p', { class: 'muted' }, '名前を呼ぶとそのキャラが答えます。「みんな」と呼べば全員が順番に答えます。声で話している途中で話しかけると、止まって聞いてくれます。'),
        canChat && chatComposer());
      return;
    }
    const text = h('input', { placeholder: '文字で話しかけることもできます', maxlength: 500 });
    const sendText = () => { if (text.value.trim()) { currentTalk.sendText(text.value.trim()); text.value = ''; } };
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendText(); });
    // 話し方：ハンズフリー（ずっと聞いている）／押して話す（周りがうるさいとき用）
    const holdMode = currentTalk.holdMode ?? false;
    const modeBtn = h('button', { class: 'secondary', onclick: () => {
      currentTalk.holdMode = !holdMode;
      currentTalk.setMicEnabled(!currentTalk.holdMode);
      renderControls();
    } }, holdMode ? 'ハンズフリーにする' : '押して話すにする');
    const hold = holdMode && h('button', { class: 'hold' }, '押している間だけ聞きます');
    if (hold) {
      const on = (e) => { e.preventDefault(); currentTalk.setMicEnabled(true); hold.classList.add('active'); };
      const off = () => { currentTalk.setMicEnabled(false); hold.classList.remove('active'); };
      hold.addEventListener('pointerdown', on);
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(ev, off);
    }
    const interpret = currentTalk.mode === 'interpret' && h('div', { class: 'row' },
      h('button', { class: currentTalk.direction === 'out' ? '' : 'secondary', onclick: () => currentTalk.setTranslation({ direction: 'out' }) }, 'わたしが話す'),
      h('button', { class: currentTalk.direction === 'in' ? '' : 'secondary', onclick: () => currentTalk.setTranslation({ direction: 'in' }) }, '相手が話す'),
      h('select', { onchange: (e) => currentTalk.setTranslation({ language: e.target.value }) },
        Object.entries(meta.languages).filter(([k]) => k !== 'ja').map(([k, l]) => h('option', { value: k, selected: currentTalk.language === k }, `日本語 ⇄ ${l}`))));
    put(controls, 
      interpret,
      hold,
      h('div', { class: 'row' }, modeBtn, h('button', { class: 'danger', onclick: () => currentTalk.stop() }, '終了')),
      currentTalk.mode !== 'interpret' && h('div', { class: 'composer' }, text, h('button', { onclick: sendText }, '送信')));
  };

  renderPicker();
  renderStage();
  renderControls();
  return [
    h('h1', {}, 'トーク'),
    stage, controls, notices, usage, log,
    h('h2', {}, '話す相手'), picker,
  ];
}

// ---- 画面：ノート（記憶と記録） ----

async function notesPage(params) {
  if (!me.user) { location.hash = '#/login'; return []; }
  const tab = params.get('tab') ?? 'memories';
  const tabs = h('div', { class: 'row' }, [['memories', '覚えていること'], ['event', '予定'], ['task', 'タスク'], ['workout', 'トレーニング'], ['quiz', '小テスト'], ['flashcard', '単語カード']]
    .map(([k, l]) => h('a', { class: `button ${tab === k ? '' : 'secondary'}`, href: `#/notes?tab=${k}` }, l)));
  let body;
  if (tab === 'memories') {
    const { memories } = await api('/api/memories');
    body = memories.length ? h('ul', { class: 'list' }, memories.map((m) => h('li', {},
      h('span', { class: 'chip' }, m.kind), ` ${m.content} `, h('span', { class: 'muted' }, `（${m.character_name}）`),
      h('label', { class: 'switch small' }, h('input', { type: 'checkbox', checked: m.scope === 'shared', onchange: (e) => api(`/api/memories/${m.id}`, { method: 'PATCH', body: { scope: e.target.checked ? 'shared' : 'private' } }) }), '全キャラで共有'),
      h('button', { class: 'secondary small', onclick: async () => { await api(`/api/memories/${m.id}`, { method: 'DELETE' }); route(); } }, '忘れてもらう'))))
      : h('p', { class: 'muted' }, 'まだありません。キャラと話すと、大事なことを覚えていきます。');
  } else {
    const { records } = await api(`/api/records?type=${tab}`);
    const fmt = (r) => ({
      event: () => `${r.data.date} ${r.data.time}　${r.data.title}`,
      task: () => `${r.data.title}${r.data.due_date ? `（${r.data.due_date}まで）` : ''}`,
      workout: () => `${r.created_at.slice(0, 10)}　${r.data.exercises.map((e) => `${e.name}${e.weight_kg != null ? ` ${e.weight_kg}kg` : ''}${e.reps != null ? `×${e.reps}` : ''}`).join('、')}`,
      quiz: () => `${r.data.correct ? '○' : '×'} ${r.data.topic}　${r.data.question}`,
      flashcard: () => `${r.data.front} — ${r.data.back}`,
    }[tab]());
    body = records.length ? h('ul', { class: 'list' }, records.map((r) => h('li', { class: r.done ? 'done' : '' },
      tab === 'task' && h('input', { type: 'checkbox', checked: r.done, onchange: async (e) => { await api(`/api/records/${r.id}`, { method: 'PATCH', body: { done: e.target.checked } }); route(); } }),
      ` ${fmt(r)} `, h('span', { class: 'muted' }, `（${r.character_name}）`),
      h('button', { class: 'secondary small', onclick: async () => { await api(`/api/records/${r.id}`, { method: 'DELETE' }); route(); } }, '削除'))))
      : h('p', { class: 'muted' }, 'まだありません。');
  }
  return [h('h1', {}, 'ノート'), h('p', { class: 'muted' }, 'キャラが会話の中で覚えたこと・記録したことです。消したものは、キャラも忘れます。'), tabs, body];
}

// ---- 画面：受信箱（キャラからのメッセージ） ----

async function inboxPage() {
  if (!me.user) { location.hash = '#/login'; return []; }
  const { messages } = await api('/api/inbox');
  api('/api/inbox/read', { method: 'POST' }).then(refreshMe).catch(() => {});
  const { publicKey } = await api('/api/push/key');
  const pushMsg = h('span', { class: 'muted' });
  const enablePush = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { pushMsg.textContent = '通知が許可されませんでした'; return; }
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      pushMsg.textContent = '通知をオンにしました';
    } catch (err) { pushMsg.textContent = `通知をオンにできませんでした（${err.message}）`; }
  };
  return [
    h('h1', {}, 'お知らせ'),
    publicKey && 'serviceWorker' in navigator && h('p', {}, h('button', { class: 'secondary', onclick: enablePush }, 'スマホ・PCに通知する'), ' ', pushMsg),
    messages.length ? h('div', { class: 'chat' }, messages.map((m) => h('div', { class: `bubble assistant${m.read_at ? '' : ' unread'}` },
      h('div', { class: 'who' }, h('a', { href: `#/c/${m.character_id}` }, m.character_name), h('span', { class: 'muted' }, ` ${m.created_at.slice(5, 16)}`)), m.text,
      h('div', {}, h('a', { href: `#/talk?ids=${m.character_id}` }, '声で返事する')))))
      : h('p', { class: 'muted' }, 'まだメッセージはありません。キャラのページで「おはよう」「おやすみ」をオンにすると届きます。'),
  ];
}

// ---- 画面：プラン ----

async function billingPage(params) {
  const catalog = await api('/api/billing/catalog');
  const msg = h('p');
  const fail = (err) => put(msg, h('span', { class: 'error' }, err.message));
  const checkout = async (path, body) => {
    if (!me.user) { location.hash = '#/login'; return; }
    try { location.href = (await api(path, { method: 'POST', body })).url; } catch (err) { fail(err); }
  };
  const status = params.get('status');
  const payment = params.get('payment');
  if (status === 'success' && payment && me.user) {
    // Webhook より先に戻ってきた場合に備えて、決済結果を照会する
    api(`/api/billing/payments/${encodeURIComponent(payment)}/sync`, { method: 'POST' })
      .then((r) => { if (r.status === 'paid') { msg.textContent = 'ポイントを追加しました。'; refreshMe(); } })
      .catch(() => {});
  }
  const sub = me.user?.id ? me.subscription : null;
  const confirmCancel = h('span');
  const askCancel = () => put(confirmCancel, 
    `${sub.currentPeriodEnd?.slice(0, 10) ?? '期間末'}まで使えます。解約しますか？ `,
    h('button', { class: 'secondary', onclick: async () => {
      try { await api('/api/billing/subscription/cancel', { method: 'POST' }); msg.textContent = '解約しました。次回以降の請求はありません。'; await refreshMe(); route(); } catch (err) { fail(err); }
    } }, '解約する'));
  const subLine = sub && sub.status !== 'closed' && sub.status !== 'pending' && h('div', { class: 'section' },
    `${catalog.plans[sub.plan].name}プラン（${sub.interval === 'year' ? '年額' : '月額'}） ・ `,
    sub.status === 'active' ? `次回更新 ${sub.currentPeriodEnd?.slice(0, 10)}` : `解約済み（${sub.currentPeriodEnd?.slice(0, 10)}まで利用可）`,
    sub.status === 'active' && h('div', { class: 'row' },
      h('button', { class: 'secondary', onclick: () => checkout('/api/billing/subscription/manage') }, '支払い方法の変更'),
      h('button', { class: 'secondary', onclick: askCancel }, '解約'),
      confirmCancel));
  return [
    h('h1', {}, 'プランとポイント'),
    status === 'success' && h('p', {}, 'お支払いを受け付けました。反映まで数秒かかることがあります。'),
    status === 'failed' && h('p', { class: 'error' }, 'お支払いが完了しませんでした。別の支払い方法でお試しください。'),
    msg,
    me.user && h('p', { class: 'status' }, usageLine()),
    subLine,
    h('h2', {}, 'サブスクリプション'),
    h('div', { class: 'plans' }, Object.entries(catalog.plans).map(([key, p]) => h('div', { class: 'card' },
      h('h3', {}, p.name),
      h('div', { class: 'price' }, p.priceJpy.month ? `月額 ${yen(p.priceJpy.month)}` : '無料'),
      p.priceJpy.year && h('div', { class: 'muted' }, `年額 ${yen(p.priceJpy.year)}`),
      h('div', {}, `文字の会話 ${p.messagesPerPeriod.toLocaleString()}回/${p.resetPeriod === 'day' ? '日' : '月'}`),
      h('div', {}, `声の会話 ${p.voiceMinutesPerPeriod.toLocaleString()}分/${p.resetPeriod === 'day' ? '日' : '月'}`),
      p.monthlyPoints > 0 && h('div', {}, `毎月 ${p.monthlyPoints}pt 付与`),
      key !== 'free' && sub?.status !== 'active' && h('div', { class: 'row' },
        h('button', { onclick: () => checkout('/api/billing/checkout/subscription', { plan: key, interval: 'month' }) }, '月額で加入'),
        p.priceJpy.year && h('button', { class: 'secondary', onclick: () => checkout('/api/billing/checkout/subscription', { plan: key, interval: 'year' }) }, '年額')),
    ))),
    h('h2', {}, 'ポイント購入'),
    h('p', { class: 'muted' }, `枠を超えた分は、文字の会話1回 ${catalog.pointCosts.chat_message}pt、声の会話1分 ${catalog.pointCosts.voice_minute}pt（グループは話す相手の人数分）。有償ポイントに有効期限はありません。`),
    h('div', { class: 'plans' }, Object.entries(catalog.pointPacks).map(([key, p]) => h('div', { class: 'card' },
      h('div', { class: 'price' }, `${p.points.toLocaleString()}pt`),
      h('div', { class: 'muted' }, yen(p.priceJpy)),
      h('button', { onclick: () => checkout('/api/billing/checkout/points', { pack: key }) }, '購入')))),
  ];
}

// ---- 画面：設定（一般ユーザー） ----

async function settingsPage() {
  if (!me.user) { location.hash = '#/login'; return []; }
  const { companions } = await api('/api/companions');
  const birth = h('input', { type: 'date', value: me.user.birthDate ?? '', max: new Date().toISOString().slice(0, 10) });
  const birthMsg = h('span', { class: 'muted' });
  const saveBirth = async () => {
    try { await api('/api/me/birth-date', { method: 'POST', body: { birthDate: birth.value } }); birthMsg.textContent = '保存しました'; }
    catch (err) { birthMsg.textContent = err.message; }
  };
  const nick = h('input', { maxlength: 20, value: me.user.nickname ?? '' });
  const nickMsg = h('span', { class: 'muted' });
  const saveNick = async () => {
    try { await api('/api/me/nickname', { method: 'PUT', body: { nickname: nick.value } }); nickMsg.textContent = '保存しました'; }
    catch (err) { nickMsg.textContent = err.message; }
  };
  const sub = me.subscription;
  return [
    h('h1', {}, '設定'),
    h('section', { class: 'panel' },
      h('h2', {}, 'プランとポイント'),
      h('p', {}, usageLine()),
      sub?.status === 'active' && h('p', { class: 'muted' }, `次回更新 ${sub.currentPeriodEnd?.slice(0, 10)}`),
      h('a', { class: 'button', href: '#/billing' }, 'プラン・ポイントを見る')),
    h('section', { class: 'panel' },
      h('h2', {}, 'わたしの相棒'),
      companions.length
        ? h('ul', { class: 'list' }, companions.map((c) => h('li', {},
          h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), h('a', { href: `#/c/${c.id}` }, c.name), h('span', { class: 'muted' }, personaLabel(c)),
          h('button', { class: 'secondary small', onclick: async () => { await api(`/api/companions/${c.id}`, { method: 'DELETE' }); route(); } }, '相棒から外す'))))
        : h('p', { class: 'muted' }, 'まだいません。'),
      h('p', { class: 'muted' }, '外しても、会話や覚えていることは残ります。また相棒にすれば続きから話せます。'),
      h('p', {}, h('a', { href: '#/make' }, '自分だけの相棒をつくる'), '　', h('a', { href: '#/discover' }, '相棒をさがす'))),
    h('section', { class: 'panel' },
      h('h2', {}, 'お知らせ'),
      h('p', { class: 'muted' }, '相棒からの朝・夜のメッセージは、各キャラのページでオン・オフできます。'),
      h('a', { href: '#/inbox' }, 'お知らせと通知の設定')),
    h('section', { class: 'panel' },
      h('h2', {}, 'アカウント'),
      h('p', {}, me.user.email),
      h('label', {}, 'あなたの呼び名（相棒があなたを呼ぶ名前）'),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, nick), h('button', { class: 'secondary', onclick: saveNick }, '保存'), nickMsg),
      h('label', {}, '生年月日（18歳以上が対象のキャラを使うときに必要です）'),
      h('div', { class: 'row' }, h('div', { style: 'flex:1' }, birth), h('button', { class: 'secondary', onclick: saveBirth }, '保存'), birthMsg),
      h('p', {}, h('a', { href: '#/notes' }, '覚えていること・記録の確認と削除（ノート）')),
      h('p', {}, h('button', { class: 'secondary', onclick: logout }, 'ログアウト'))),
    h('section', { class: 'panel muted-panel' },
      h('h2', {}, 'クリエイターの方へ'),
      h('p', { class: 'muted' }, '自分でキャラをつくって公開し、話された分に応じて報酬を受け取れます（準備中の機能を含みます）。'),
      h('a', { href: '#/creator' }, 'クリエイター画面へ')),
  ];
}

// ---- 画面：クリエイター（キャラの作成・公開・報酬） ----

async function creatorPage() {
  if (!me.user) { location.hash = '#/login'; return []; }
  const { characters } = await api('/api/my/characters');
  const r = me.rewards;
  const msg = h('span');
  const payout = async () => {
    try { const p = await api('/api/creator/payouts', { method: 'POST' }); msg.textContent = `${p.amountR}R の出金を申請しました`; await refreshMe(); }
    catch (err) { put(msg, h('span', { class: 'error' }, err.message)); }
  };
  return [
    h('p', {}, h('a', { href: '#/settings' }, '← 設定')),
    h('h1', {}, 'クリエイター'),
    h('p', { class: 'notice info' }, 'クリエイター向けの機能は準備中です。いまはキャラの作成・公開と、報酬の確認ができます。'),
    h('div', { class: 'row spread' }, h('h2', {}, 'つくったキャラ'), h('a', { class: 'button', href: '#/creator/new' }, 'キャラをつくる')),
    characters.length
      ? h('div', { class: 'grid' }, characters.map((c) => h('a', { class: 'card', href: `#/creator/edit/${c.id}` },
        h('div', { class: 'card-head' }, h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), h('h3', {}, c.name)),
        h('div', { class: 'tags' }, `${personaLabel(c)} ・ ${{ public: '公開', unlisted: '限定公開', private: '非公開' }[c.visibility]} ・ 会話 ${c.chat_count}`))))
      : h('p', { class: 'muted' }, 'まだありません。'),
    h('h2', {}, '報酬'),
    h('p', {}, `出金可能 ${r.available}R ・ 保留中 ${r.pending}R ・ 申請済み ${r.requestedOrPaid}R（最低出金 ${r.minPayoutR}R）`),
    h('p', {}, h('button', { onclick: payout, disabled: r.available < r.minPayoutR }, '出金を申請'), ' ', msg),
  ];
}

// ---- 画面：新規登録（つくった相棒を連れて登録する） ----

function signupPage() {
  const draft = loadDraft();
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
  const nickname = h('input', { maxlength: 20, placeholder: '例：ゆう' });
  const needsAge = draft?.persona === 'partner';
  const birth = h('input', { type: 'date', max: new Date().toISOString().slice(0, 10) });
  const msg = h('div');
  const form = h('div', { class: 'stack' });
  const greeting = draft && (draft.opening || `はじめまして、${draft.name}です。これからよろしくね。`);
  const voiceMsg = h('span', { class: 'muted small' });
  const submit = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api('/auth/login', { method: 'POST', body: {
        email: email.value.trim(), nickname: nickname.value.trim(), birthDate: needsAge ? birth.value : undefined, character: draft ?? undefined,
      } });
      put(form, h('section', { class: 'panel' },
        h('h2', {}, 'メールを送りました'),
        h('p', {}, h('b', {}, email.value.trim()), ' に届いたリンクを開くと、', draft ? `${draft.name}が待つマイページ` : 'マイページ', 'に進みます。'),
        h('p', { class: 'muted small' }, 'リンクの有効期限は15分です。届かないときは、迷惑メールのフォルダも確認してください。スマホで開いても大丈夫です。'),
        r.devLink && h('p', {}, '開発モード：', h('a', { href: r.devLink }, 'ここをクリックして登録を完了'))));
    } catch (err) {
      btn.disabled = false;
      put(msg, h('p', { class: 'error' }, err.message));
    }
  };
  put(form,
    h('label', {}, 'あなたの呼び名', h('span', { class: 'muted small' }, '（相棒があなたを呼ぶ名前。なくてもOK）')), nickname,
    h('label', {}, 'メールアドレス'), email,
    needsAge && [h('label', {}, '生年月日', h('span', { class: 'muted small' }, '（恋人の相棒は18歳以上の方が対象です）')), birth],
    msg,
    h('p', {}, h('button', { class: 'big', onclick: (e) => submit(e.currentTarget) }, '登録してはじめる（無料）')),
    h('p', { class: 'muted small' }, 'パスワードは不要です。メールに届くリンクから登録が完了します。登録で50ptプレゼント。'));
  return [
    draft && h('ol', { class: 'progress' }, h('li', { class: 'done' }, '相棒をつくる'), h('li', { class: 'on' }, '無料登録'), h('li', {}, 'マイページで話す')),
    draft
      ? h('section', { class: 'panel made' },
        h('div', { class: 'card-head' }, h('span', { class: `avatar big p-${draft.persona}` }, initial(draft.name)),
          h('div', {}, h('p', { class: 'muted small' }, 'あなただけの相棒ができました'), h('h1', {}, draft.name), h('div', { class: 'tags' }, MAKE_ROLES[draft.persona]?.[0]))),
        h('div', { class: 'bubble assistant' }, greeting),
        h('div', { class: 'row' },
          meta.voiceAvailable && h('button', { class: 'secondary small', onclick: async () => { voiceMsg.textContent = '再生の準備中…'; voiceMsg.textContent = await playSpeech({ voice: draft.voice, speed: draft.voice_speed, text: greeting }) ?? ''; } }, '▶ 声を聞く'),
          h('a', { href: '#/make' }, '← 相棒を直す'), voiceMsg))
      : h('section', { class: 'greeting' }, h('h1', {}, 'AIボウをはじめる'),
        h('p', { class: 'muted' }, '先に', h('a', { href: '#/make' }, '自分だけの相棒をつくってから'), '登録すると、マイページですぐに話せます。')),
    h('h2', {}, draft ? `${draft.name}と話すために、無料登録` : '無料登録'),
    form,
    h('p', { class: 'muted small' }, 'すでに登録済みの方は ', h('a', { href: '#/login' }, 'ログイン')),
  ];
}

function loginPage() {
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
  const msg = h('p');
  const submit = async () => {
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: email.value.trim() } });
      put(msg, 'ログイン用のリンクをメールで送りました。',
        r.devLink ? [h('br'), '開発モード: ', h('a', { href: r.devLink }, 'ここをクリックしてログイン')] : null);
    } catch (err) { put(msg, h('span', { class: 'error' }, err.message)); }
  };
  return [h('h1', {}, 'ログイン'), h('p', { class: 'muted' }, 'メールアドレスに届くリンクからログインします。'),
    email, h('p', {}, h('button', { onclick: submit }, 'リンクを送る')), msg,
    h('p', { class: 'muted small' }, 'はじめての方は ', h('a', { href: '#/make' }, '自分だけの相棒をつくる'), ' から。')];
}

// ---- ルーター ----

async function route() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);
  // 通話中にほかのページへ移ったら切る
  if (currentTalk && parts[0] !== 'talk') { currentTalk.stop(); currentTalk = null; }
  if (parts[0] === 'talk' && currentTalk) return;
  try {
    await refreshMe();
    let content;
    if (parts.length === 0) content = await homePage(params);
    else if (parts[0] === 'about') content = await landingPage();
    else if (parts[0] === 'discover') content = await discoverPage(params);
    else if (parts[0] === 'c') content = await characterPage(parts[1]);
    else if (parts[0] === 'chat') content = await chatPage(parts[1]);
    else if (parts[0] === 'talk') content = await talkPage(params);
    else if (parts[0] === 'notes') content = await notesPage(params);
    else if (parts[0] === 'inbox') content = await inboxPage();
    else if (parts[0] === 'billing') content = await billingPage(params);
    else if (parts[0] === 'settings') content = await settingsPage();
    else if (parts[0] === 'make') content = await makePage(parts[1] ?? null, params);
    else if (parts[0] === 'signup') content = me.user ? (location.replace('#/'), []) : signupPage();
    else if (parts[0] === 'creator' && parts[1] === 'new') content = await editPage(null);
    else if (parts[0] === 'creator' && parts[1] === 'edit') content = await editPage(parts[2]);
    else if (parts[0] === 'creator') content = await creatorPage();
    // 以前の URL
    else if (parts[0] === 'me') { location.replace('#/settings'); return; }
    else if (parts[0] === 'create') { location.replace('#/creator/new'); return; }
    else if (parts[0] === 'edit') { location.replace(`#/creator/edit/${parts[1]}`); return; }
    else if (parts[0] === 'login') content = me.user ? (location.replace('#/'), []) : loginPage();
    else content = h('p', {}, 'ページが見つかりません');
    document.body.classList.toggle('is-landing', !me.user && parts.length === 0 || parts[0] === 'about');
    put(view, ...[content].flat(Infinity).filter((x) => x != null && x !== false));
    window.scrollTo(0, 0); // ページが変わったら先頭から
  } catch (err) {
    put(view, h('p', { class: 'error' }, err.message));
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', () => currentTalk?.stop());
route();
