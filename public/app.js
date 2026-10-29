// 依存なしの小さな SPA。ハッシュでルーティングし、DOM は h() で組み立てる（innerHTML は使わない）。

import { VoiceTalk } from './voice.js';

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
  const acc = document.getElementById('account');
  if (!me.user) {
    put(acc, h('a', { href: '#/login' }, 'ログイン'));
    return;
  }
  const inbox = await api('/api/inbox').catch(() => ({ unread: 0 }));
  put(acc, 
    h('a', { href: '#/inbox' }, '受信箱', inbox.unread ? h('span', { class: 'badge' }, String(inbox.unread)) : null), ' ',
    h('a', { href: '#/me' }, `${me.points.total}pt`), ' ',
    h('button', { class: 'secondary', onclick: async () => { await api('/auth/logout', { method: 'POST' }); await route(); } }, 'ログアウト'));
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

async function homePage(params) {
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'popular';
  const { characters } = await api(`/api/characters?sort=${sort}&q=${encodeURIComponent(q)}`);
  const search = h('input', { placeholder: 'キャラ名・タグで検索', value: q });
  const go = (s) => { location.hash = `#/?q=${encodeURIComponent(search.value)}&sort=${s}`; };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(sort); });
  const companions = characters.filter((c) => c.persona !== 'chat');
  const others = characters.filter((c) => c.persona === 'chat');
  const card = (c) => h('a', { class: 'card', href: `#/c/${c.id}` },
    h('div', { class: 'card-head' }, h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), h('h3', {}, c.name)),
    h('div', {}, c.tagline),
    h('div', { class: 'tags' }, c.persona !== 'chat' && h('span', { class: 'chip' }, personaLabel(c)), ` ${c.tags} ・ 会話 ${c.chat_count} ・ by ${c.creator}`));
  return [
    h('section', { class: 'hero' },
      h('h1', {}, '話せる相手が、毎日の味方になる'),
      h('p', {}, '声で話しかけるだけ。予定を覚える秘書、記録を見てくれるトレーナー、あなたを覚えている恋人まで。何人とでも、同時に話せます。'),
      me.user && h('a', { class: 'button big', href: '#/talk' }, '声で話してみる')),
    h('div', { class: 'row' }, search,
      h('button', { class: sort === 'popular' ? '' : 'secondary', onclick: () => go('popular') }, '人気'),
      h('button', { class: sort === 'new' ? '' : 'secondary', onclick: () => go('new') }, '新着')),
    companions.length > 0 && [h('h2', {}, 'くらしのパートナー'), h('div', { class: 'grid' }, companions.map(card))],
    h('h2', {}, q ? `「${q}」の検索結果` : '会話キャラ'),
    others.length || companions.length
      ? h('div', { class: 'grid' }, others.map(card))
      : h('p', { class: 'muted' }, 'まだキャラがありません。「つくる」から最初のキャラを公開してみましょう。'),
  ];
}

// ---- 画面：キャラ詳細 ----

async function characterPage(id) {
  const { character: c } = await api(`/api/characters/${id}`);
  const msg = h('div');
  const startChat = async () => {
    if (!me.user) { location.hash = '#/login'; return; }
    try {
      const { id: convId } = await api(`/api/characters/${c.id}/conversations`, { method: 'POST' });
      location.hash = `#/chat/${convId}`;
    } catch (err) {
      if (err.data?.code === 'age_required') put(msg, birthDateForm(startChat));
      else put(msg, h('p', { class: 'error' }, err.message));
    }
  };
  const isOwner = me.user?.id === c.creator_id;
  return [
    h('div', { class: 'card-head' }, h('span', { class: `avatar big p-${c.persona}` }, initial(c.name)),
      h('div', {}, h('h1', {}, c.name), h('div', { class: 'tags' }, c.persona !== 'chat' && h('span', { class: 'chip' }, personaLabel(c)), ` by ${c.creator}`))),
    h('p', {}, c.tagline),
    h('div', { class: 'row' },
      me.user && h('a', { class: 'button big', href: `#/talk?ids=${c.id}` }, c.persona === 'interpreter' ? '通訳をはじめる' : '声で話す'),
      c.persona !== 'interpreter' && h('button', { class: 'secondary', onclick: startChat }, '文字で話す'),
      isOwner && h('a', { class: 'button secondary', href: `#/edit/${c.id}` }, '編集')),
    msg,
    c.persona === 'other' && c.role && [h('h2', {}, '役割'), h('div', { class: 'section' }, c.role)],
    c.world_setting && [h('h2', {}, '基本設定'), h('div', { class: 'section' }, c.world_setting)],
    c.profile && [h('h2', {}, 'プロフィール'), h('div', { class: 'section' }, c.profile)],
    c.opening && [h('h2', {}, '最初のひとこと'), h('div', { class: 'section' }, c.opening)],
    me.user && c.persona !== 'interpreter' && await tweakCard(c),
    me.user && c.persona !== 'interpreter' && await proactiveCard(c),
  ];
}

// 調整：プロンプトで性格・話し方を微修正。作成者は公開中の調整、それ以外は自分用の調整。
const TWEAK_CHIPS = ['返答はもっと短く', '敬語で話す', 'タメ口で話す', '関西弁で話す', 'もっと褒めて', '厳しめに', '質問を多めに', '絵文字を使わない'];

async function tweakCard(c) {
  const t = await api(`/api/characters/${c.id}/tweaks`);
  const scope = t.isCreator ? 'creator' : 'personal';
  const area = h('textarea', { maxlength: 1000, placeholder: '例：語尾を「〜だぜ」にする／返答は1文で／敬語をやめる' });
  area.value = t.isCreator ? t.creator : t.personal;
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
    h('h2', {}, t.isCreator ? '性格・話し方の調整（公開中のキャラに反映）' : 'あなた用の調整'),
    h('p', { class: 'muted' }, t.isCreator
      ? 'プロンプト（指示文）でキャラの性格や返答の仕方を微調整します。会話する全員に反映されます。'
      : 'あなたとの会話だけに反映されます。作成者の設定は変わりません。'),
    h('div', { class: 'chips' }, TWEAK_CHIPS.map((x) => h('button', { class: 'chip-btn', onclick: () => {
      area.value = area.value.trim() ? `${area.value.trim()}／${x}` : x;
    } }, x))),
    area,
    h('div', { class: 'row' }, h('button', { onclick: save }, '保存'), h('button', { class: 'secondary', onclick: (e) => compare(e.currentTarget) }, '調整前と比べる（2回分）')),
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
    h('p', {}, h('a', { href: '#/inbox' }, '受信箱と通知の設定へ')));
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
    voice: h('select', {}, meta.voices.map((v) => h('option', { value: v, selected: c.voice === v }, v))),
    voice_speed: h('input', { type: 'range', min: '0.7', max: '1.3', step: '0.05', value: String(c.voice_speed ?? 1) }),
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
  const speedLabel = h('span', { class: 'muted' });
  const updateSpeed = () => { speedLabel.textContent = ` ${Number(fields.voice_speed.value).toFixed(2)}倍`; };
  fields.voice_speed.addEventListener('input', updateSpeed);
  updateSpeed();
  const voiceMsg = h('span', { class: 'muted' });
  const preview = async () => {
    voiceMsg.textContent = '再生の準備中…';
    const res = await fetch('/api/voice/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: fields.voice.value, speed: Number(fields.voice_speed.value), text: fields.opening.value || undefined }),
    });
    if (!res.ok) { voiceMsg.textContent = (await res.json().catch(() => ({}))).error ?? '再生できませんでした'; return; }
    voiceMsg.textContent = 'AIが生成した音声です';
    new Audio(URL.createObjectURL(await res.blob())).play();
  };
  const msg = h('p');
  const save = async () => {
    const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
    body.voice_speed = Number(body.voice_speed);
    try {
      const r = id ? await api(`/api/characters/${id}`, { method: 'PUT', body }) : await api('/api/characters', { method: 'POST', body });
      location.hash = `#/c/${id ?? r.id}`;
    } catch (err) { put(msg, h('span', { class: 'error' }, err.message)); }
  };
  const field = (label, el) => [h('label', {}, label), el];
  return [
    h('h1', {}, id ? 'キャラを編集' : 'キャラをつくる'),
    h('p', { class: 'muted' }, '役割（基本ペルソナ）を選ぶと、その役割に必要な道具（記録・予定・単語カードなど）が自動で付きます。個性は自由に決められます。'),
    field('基本ペルソナ（役割）', fields.persona), help, roleWrap,
    field('キャラ名', fields.name),
    field('紹介文', fields.tagline),
    field('基本設定（舞台・ユーザの立場）', fields.world_setting),
    field('プロフィール（性格・口調）', fields.profile),
    field('最初のひとこと', fields.opening),
    h('label', {}, '声'),
    h('div', { class: 'row' }, h('div', { style: 'flex:1' }, fields.voice), h('button', { class: 'secondary', onclick: preview }, '試しに聞く'), voiceMsg),
    h('label', {}, '話す速さ', speedLabel), fields.voice_speed,
    field('タグ（カンマ区切り）', fields.tags),
    field('公開範囲', fields.visibility),
    msg,
    h('p', {}, h('button', { onclick: save }, '保存')),
  ];
}

// ---- 画面：トーク（声で話す） ----

async function talkPage(params) {
  if (!me.user) { location.hash = '#/login'; return []; }
  const [{ characters: mine }, { characters: popular }] = await Promise.all([api('/api/my/characters'), api('/api/characters?sort=popular')]);
  const pool = [...new Map([...mine, ...popular].map((c) => [c.id, c])).values()];
  let selected = (params.get('ids') ?? '').split(',').map(Number).filter((id) => pool.some((c) => c.id === id)).slice(0, 4);

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
      put(controls, 
        h('button', { class: 'big talk-start', disabled: !members().length || !meta.voiceAvailable, onclick: (e) => start(e.currentTarget) },
          modeOf() === 'interpret' ? '通訳をはじめる' : '話しはじめる'),
        !meta.voiceAvailable && h('p', { class: 'muted' }, '音声は準備中です（運営が OPENAI_API_KEY を設定すると使えます）。キャラのページから文字で話せます。'),
        members().length > 1 && h('p', { class: 'muted' }, '名前を呼ぶとそのキャラが答えます。「みんな」と呼べば全員が順番に答えます。話している途中で話しかけると、止まって聞いてくれます。'));
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
    h('h1', {}, '受信箱'),
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

// ---- 画面：マイページ ----

async function mePage() {
  if (!me.user) { location.hash = '#/login'; return []; }
  const { characters } = await api('/api/my/characters');
  const r = me.rewards;
  const msg = h('span');
  const payout = async () => {
    try { const p = await api('/api/creator/payouts', { method: 'POST' }); msg.textContent = `${p.amountR}R の出金を申請しました`; await refreshMe(); }
    catch (err) { put(msg, h('span', { class: 'error' }, err.message)); }
  };
  return [
    h('h1', {}, 'マイページ'),
    h('p', { class: 'status' }, usageLine()),
    h('div', { class: 'row' }, h('a', { class: 'button big', href: '#/talk' }, 'トーク'), h('a', { class: 'button secondary', href: '#/notes' }, 'ノート'), h('a', { class: 'button secondary', href: '#/inbox' }, '受信箱')),
    h('h2', {}, 'クリエイター報酬'),
    h('p', {}, `出金可能 ${r.available}R ・ 保留中 ${r.pending}R ・ 申請済み ${r.requestedOrPaid}R（最低出金 ${r.minPayoutR}R）`),
    h('p', {}, h('button', { onclick: payout, disabled: r.available < r.minPayoutR }, '出金を申請'), ' ', msg),
    h('h2', {}, 'つくったキャラ'),
    characters.length
      ? h('div', { class: 'grid' }, characters.map((c) => h('a', { class: 'card', href: `#/c/${c.id}` },
        h('div', { class: 'card-head' }, h('span', { class: `avatar p-${c.persona}` }, initial(c.name)), h('h3', {}, c.name)),
        h('div', { class: 'tags' }, `${personaLabel(c)} ・ ${c.visibility} ・ 会話 ${c.chat_count}`))))
      : h('p', { class: 'muted' }, 'まだありません。'),
  ];
}

function loginPage() {
  const email = h('input', { type: 'email', placeholder: 'you@example.com' });
  const msg = h('p');
  const submit = async () => {
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: email.value } });
      put(msg, 'ログイン用リンクをメールで送りました。',
        r.devLink ? [h('br'), '開発モード: ', h('a', { href: r.devLink }, 'ここをクリックしてログイン')] : null);
    } catch (err) { put(msg, h('span', { class: 'error' }, err.message)); }
  };
  return [h('h1', {}, 'ログイン / 新規登録'), h('p', { class: 'muted' }, 'メールアドレスに届くリンクからログインします。新規登録で50ptプレゼント。'),
    email, h('p', {}, h('button', { onclick: submit }, 'リンクを送る')), msg];
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
    else if (parts[0] === 'c') content = await characterPage(parts[1]);
    else if (parts[0] === 'chat') content = await chatPage(parts[1]);
    else if (parts[0] === 'create') content = await editPage(null);
    else if (parts[0] === 'edit') content = await editPage(parts[1]);
    else if (parts[0] === 'talk') content = await talkPage(params);
    else if (parts[0] === 'notes') content = await notesPage(params);
    else if (parts[0] === 'inbox') content = await inboxPage();
    else if (parts[0] === 'billing') content = await billingPage(params);
    else if (parts[0] === 'me') content = await mePage();
    else if (parts[0] === 'login') content = loginPage();
    else content = h('p', {}, 'ページが見つかりません');
    put(view, ...[content].flat(Infinity).filter((x) => x != null && x !== false));
  } catch (err) {
    put(view, h('p', { class: 'error' }, err.message));
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', () => currentTalk?.stop());
route();
