// 依存なしの小さな SPA。ハッシュでルーティングし、DOM は h() で組み立てる（innerHTML は使わない）。

const view = document.getElementById('view');
let me = null;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
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

async function refreshMe() {
  me = await api('/api/me');
  const acc = document.getElementById('account');
  acc.replaceChildren(me.user
    ? h('span', {}, h('a', { href: '#/me' }, `${me.points.total}pt`), ' ',
      h('button', { class: 'secondary', onclick: async () => { await api('/auth/logout', { method: 'POST' }); await route(); } }, 'ログアウト'))
    : h('a', { href: '#/login' }, 'ログイン'));
}

function usageLine() {
  if (!me?.user) return '';
  const u = me.usage.chat;
  return `${me.usage.plan.toUpperCase()}プラン ・ 会話 ${u.used}/${u.limit}（${me.usage.plan === 'free' ? '毎日リセット' : '契約期間ごと'}） ・ ポイント ${me.points.total}pt（有償 ${me.points.paid} / 無償 ${me.points.free}）`;
}

// ---- 画面 ----

async function homePage(params) {
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'popular';
  const { characters } = await api(`/api/characters?sort=${sort}&q=${encodeURIComponent(q)}`);
  const search = h('input', { placeholder: 'キャラ名・タグで検索', value: q });
  const go = (s) => { location.hash = `#/?q=${encodeURIComponent(search.value)}&sort=${s}`; };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(sort); });
  return [
    h('h1', {}, 'AIキャラと出会って、話そう'),
    h('div', { class: 'row' }, search,
      h('button', { class: sort === 'popular' ? '' : 'secondary', onclick: () => go('popular') }, '人気'),
      h('button', { class: sort === 'new' ? '' : 'secondary', onclick: () => go('new') }, '新着')),
    h('h2', {}, q ? `「${q}」の検索結果` : '公開キャラ'),
    characters.length
      ? h('div', { class: 'grid' }, characters.map((c) => h('a', { class: 'card', href: `#/c/${c.id}` },
        h('h3', {}, c.name), h('div', {}, c.tagline), h('div', { class: 'tags' }, `${c.tags} ・ 会話 ${c.chat_count} ・ by ${c.creator}`))))
      : h('p', { class: 'muted' }, 'まだキャラがありません。「つくる」から最初のキャラを公開してみましょう。'),
  ];
}

async function characterPage(id) {
  const { character: c } = await api(`/api/characters/${id}`);
  const start = async () => {
    if (!me.user) { location.hash = '#/login'; return; }
    const { id: convId } = await api(`/api/characters/${c.id}/conversations`, { method: 'POST' });
    location.hash = `#/chat/${convId}`;
  };
  return [
    h('h1', {}, c.name),
    h('p', {}, c.tagline),
    h('p', { class: 'tags' }, `${c.tags} ・ by ${c.creator}`),
    c.world_setting && [h('h2', {}, '基本設定'), h('div', { class: 'section' }, c.world_setting)],
    c.profile && [h('h2', {}, 'プロフィール'), h('div', { class: 'section' }, c.profile)],
    c.opening && [h('h2', {}, '導入'), h('div', { class: 'section' }, c.opening)],
    h('p', {}, h('button', { onclick: start }, '会話をはじめる'),
      me.user?.id === c.creator_id ? [' ', h('a', { class: 'button', href: `#/edit/${c.id}` }, '編集')] : null),
  ];
}

async function chatPage(id) {
  const data = await api(`/api/conversations/${id}`);
  const list = h('div', { class: 'chat' });
  const addBubble = (role, text) => { list.append(h('div', { class: `bubble ${role}` }, text)); };
  if (data.character.opening) addBubble('assistant', data.character.opening);
  for (const m of data.messages) addBubble(m.role, m.content);

  const status = h('div', { class: 'status' }, usageLine());
  const input = h('textarea', { placeholder: 'メッセージを入力（Ctrl+Enter で送信）', maxlength: 2000 });
  const send = h('button', {}, '送信');
  const submit = async () => {
    const content = input.value.trim();
    if (!content) return;
    send.disabled = true;
    addBubble('user', content);
    input.value = '';
    try {
      const r = await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { content } });
      addBubble('assistant', r.message.content);
      me.points = r.points; me.usage = r.usage;
      status.textContent = usageLine() + (r.charged.via === 'points' ? ` ・ 今回 ${r.charged.points}pt 消費` : '');
      await refreshMe();
    } catch (err) {
      list.lastChild.remove();
      input.value = content;
      status.replaceChildren(h('span', { class: 'error' }, err.message),
        err.status === 402 ? [' ', h('a', { href: '#/billing' }, 'プラン・ポイントを見る')] : null);
    } finally {
      send.disabled = false;
      window.scrollTo(0, document.body.scrollHeight);
    }
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight));
  return [h('h1', {}, h('a', { href: `#/c/${data.character.id}` }, data.character.name)), status, list, h('div', { class: 'composer' }, input, send)];
}

async function editPage(id) {
  if (!me.user) { location.hash = '#/login'; return []; }
  const c = id ? (await api(`/api/characters/${id}`)).character : { visibility: 'public' };
  const fields = {
    name: h('input', { value: c.name ?? '', maxlength: 50 }),
    tagline: h('input', { value: c.tagline ?? '', maxlength: 200, placeholder: '例：閉館後の図書館で、返却されない本を探す司書に声をかけられる' }),
    world_setting: h('textarea', { maxlength: 4000, placeholder: '舞台、ユーザの立場、物語の前提' }),
    profile: h('textarea', { maxlength: 4000, placeholder: '年齢、外見、口調、一人称、性格、ユーザとの距離感' }),
    opening: h('textarea', { maxlength: 2000, placeholder: '会話が始まる瞬間のナレーションと最初の一言' }),
    tags: h('input', { value: c.tags ?? '', maxlength: 200, placeholder: 'ファンタジー, 幼なじみ' }),
    visibility: h('select', {}, ['public', 'unlisted', 'private'].map((v) =>
      h('option', { value: v, selected: c.visibility === v }, { public: '公開', unlisted: '限定公開（URLを知る人だけ）', private: '非公開' }[v]))),
  };
  fields.world_setting.value = c.world_setting ?? '';
  fields.profile.value = c.profile ?? '';
  fields.opening.value = c.opening ?? '';
  const msg = h('p');
  const save = async () => {
    const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
    try {
      const r = id ? await api(`/api/characters/${id}`, { method: 'PUT', body }) : await api('/api/characters', { method: 'POST', body });
      location.hash = `#/c/${id ?? r.id}`;
    } catch (err) { msg.replaceChildren(h('span', { class: 'error' }, err.message)); }
  };
  const label = { name: 'キャラ名', tagline: '紹介文（一文で会話の入口）', world_setting: '基本設定', profile: 'プロフィール', opening: '導入文', tags: 'タグ（カンマ区切り）', visibility: '公開範囲' };
  return [
    h('h1', {}, id ? 'キャラを編集' : 'キャラをつくる'),
    Object.entries(fields).map(([k, el]) => [h('label', {}, label[k]), el]),
    msg,
    h('p', {}, h('button', { onclick: save }, '保存')),
  ];
}

async function billingPage(params) {
  const catalog = await api('/api/billing/catalog');
  const checkout = async (path, body) => {
    if (!me.user) { location.hash = '#/login'; return; }
    try { location.href = (await api(path, { method: 'POST', body })).url; } catch (err) { alert(err.message); }
  };
  const status = params.get('status');
  return [
    h('h1', {}, 'プランとポイント'),
    status === 'success' && h('p', {}, 'お支払いを受け付けました。反映まで数秒かかることがあります（コンビニ・銀行振込は入金確認後）。'),
    me.user && h('p', { class: 'status' }, usageLine()),
    h('h2', {}, 'サブスクリプション'),
    h('div', { class: 'plans' }, Object.entries(catalog.plans).map(([key, p]) => h('div', { class: 'card' },
      h('h3', {}, p.name),
      h('div', { class: 'price' }, p.priceJpy.month ? `月額 ${yen(p.priceJpy.month)}` : '無料'),
      p.priceJpy.year && h('div', { class: 'muted' }, `年額 ${yen(p.priceJpy.year)}`),
      h('div', {}, `会話 ${p.messagesPerPeriod.toLocaleString()}回/${p.resetPeriod === 'day' ? '日' : '月'}`),
      p.monthlyPoints > 0 && h('div', {}, `毎月 ${p.monthlyPoints}pt 付与`),
      key !== 'free' && h('div', { class: 'row' },
        h('button', { onclick: () => checkout('/api/billing/checkout/subscription', { plan: key, interval: 'month' }) }, '月額で加入'),
        p.priceJpy.year && h('button', { class: 'secondary', onclick: () => checkout('/api/billing/checkout/subscription', { plan: key, interval: 'year' }) }, '年額')),
    ))),
    me.user && h('p', {}, h('button', { class: 'secondary', onclick: () => checkout('/api/billing/portal') }, '契約の変更・解約')),
    h('h2', {}, 'ポイント購入'),
    h('p', { class: 'muted' }, `会話枠を超えた分は1回 ${catalog.pointCosts.chat_message}pt。有償ポイントに有効期限はありません。`),
    h('div', { class: 'plans' }, Object.entries(catalog.pointPacks).map(([key, p]) => h('div', { class: 'card' },
      h('div', { class: 'price' }, `${p.points.toLocaleString()}pt`),
      h('div', { class: 'muted' }, yen(p.priceJpy)),
      h('button', { onclick: () => checkout('/api/billing/checkout/points', { pack: key }) }, '購入')))),
  ];
}

async function mePage() {
  if (!me.user) { location.hash = '#/login'; return []; }
  const { characters } = await api('/api/my/characters');
  const r = me.rewards;
  const msg = h('span');
  const payout = async () => {
    try { const p = await api('/api/creator/payouts', { method: 'POST' }); msg.textContent = `${p.amountR}R の出金を申請しました`; await refreshMe(); }
    catch (err) { msg.replaceChildren(h('span', { class: 'error' }, err.message)); }
  };
  return [
    h('h1', {}, 'マイページ'),
    h('p', { class: 'status' }, usageLine()),
    h('h2', {}, 'クリエイター報酬'),
    h('p', {}, `出金可能 ${r.available}R ・ 保留中 ${r.pending}R ・ 申請済み ${r.requestedOrPaid}R（最低出金 ${r.minPayoutR}R）`),
    h('p', {}, h('button', { onclick: payout, disabled: r.available < r.minPayoutR }, '出金を申請'), ' ', msg),
    h('h2', {}, 'つくったキャラ'),
    characters.length
      ? h('div', { class: 'grid' }, characters.map((c) => h('a', { class: 'card', href: `#/c/${c.id}` },
        h('h3', {}, c.name), h('div', { class: 'tags' }, `${c.visibility} ・ 会話 ${c.chat_count}`))))
      : h('p', { class: 'muted' }, 'まだありません。'),
  ];
}

function loginPage() {
  const email = h('input', { type: 'email', placeholder: 'you@example.com' });
  const msg = h('p');
  const submit = async () => {
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: email.value } });
      msg.replaceChildren('ログイン用リンクをメールで送りました。',
        r.devLink ? [h('br'), '開発モード: ', h('a', { href: r.devLink }, 'ここをクリックしてログイン')] : null);
    } catch (err) { msg.replaceChildren(h('span', { class: 'error' }, err.message)); }
  };
  return [h('h1', {}, 'ログイン / 新規登録'), h('p', { class: 'muted' }, 'メールアドレスに届くリンクからログインします。新規登録で50ptプレゼント。'),
    email, h('p', {}, h('button', { onclick: submit }, 'リンクを送る')), msg];
}

// ---- ルーター ----

async function route() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);
  try {
    await refreshMe();
    let content;
    if (parts.length === 0) content = await homePage(params);
    else if (parts[0] === 'c') content = await characterPage(parts[1]);
    else if (parts[0] === 'chat') content = await chatPage(parts[1]);
    else if (parts[0] === 'create') content = await editPage(null);
    else if (parts[0] === 'edit') content = await editPage(parts[1]);
    else if (parts[0] === 'billing') content = await billingPage(params);
    else if (parts[0] === 'me') content = await mePage();
    else if (parts[0] === 'login') content = loginPage();
    else content = h('p', {}, 'ページが見つかりません');
    view.replaceChildren(...[content].flat(Infinity).filter((x) => x != null && x !== false));
  } catch (err) {
    view.replaceChildren(h('p', { class: 'error' }, err.message));
  }
}

window.addEventListener('hashchange', route);
route();
