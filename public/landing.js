// メインページ（ログイン前のサービス紹介）。絵コンテ風に「つくる → 話す → 覚えて声をかける」を見せ、
// お試し会話とテンプレートのギャラリーから、自分だけの相棒づくりへつなぐ。
// app.js の部品（h, put, api など）は ctx で受け取る。

// 役割ごとのアイコン（線画の SVG パス）
const ICONS = {
  chat: 'M4 5h16v10H9l-5 4z',
  tutor: 'M3 6l9-3 9 3-9 3zM7 8v5c0 1.5 2.5 3 5 3s5-1.5 5-3V8M21 6v6',
  secretary: 'M12 10l-7-4v8zM12 10l7-4v8zM12 10v0M10.5 10a1.5 1.5 0 103 0 1.5 1.5 0 10-3 0',
  trainer: 'M3 9v6M6 7v10M18 7v10M21 9v6M6 12h12',
  partner: 'M12 20s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.5-7 10-7 10z',
  language: 'M12 3a9 9 0 100 18 9 9 0 100-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9',
  interpreter: 'M3 5h10v7H7l-4 3zM11 14h6l4 3v-9h-6',
  other: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
};

// ギャラリーのテンプレート。「この相棒をもとにつくる」で相棒づくりの下書きになる。
const TEMPLATES = [
  { slug: 'haru', name: 'ハル', persona: 'chat', voice: 'marin', tag: '幼なじみ',
    profile: '24歳。一人称は「わたし」。明るくてよく笑う幼なじみ。タメ口で話す。あなたの話を最後まで聞いて、次に話すときに「そういえばあれ、どうなった？」と続きを聞いてくれる。',
    opening: 'おかえり！ 今日はどうだった？ ちょっとでいいから聞かせて。' },
  { slug: 'souta', name: 'ソウタ先輩', persona: 'tutor', voice: 'ash', tag: '受験の先輩',
    profile: '23歳。理系の大学院生。一人称は「俺」。面倒見のいい先輩で、くだけた話し方。勉強法を具体的に教え、つまずいたところは図や例えで説明し直す。サボった日も責めずに、次の一歩を小さく決めてくれる。',
    opening: 'おつかれ。今日はどこまで進んだ？ わからないとこ、一緒に片付けよう。' },
  { slug: 'sae', name: 'サエ', persona: 'secretary', voice: 'sage', tag: '社長秘書',
    profile: '31歳。外資系企業で社長秘書をしていた。一人称は「わたくし」。敬語で端的に話し、結論から伝える。予定の重なりや移動時間の不足に先に気づき、代わりの案を一つ添える。',
    opening: 'おはようございます、サエです。本日のご予定を確認いたしましょうか。' },
  { slug: 'ryu', name: 'リュウ', persona: 'trainer', voice: 'echo', tag: '元ボクサー',
    profile: '30歳。元プロボクサーのトレーナー。一人称は「俺」。熱いけれど無理はさせない。前回の記録を覚えていて、少しでも伸びたら全力で褒める。フォームの注意は一度に一つだけ。',
    opening: 'よし、来たな！ 今日の体の調子はどうだ？ そこからメニューを決めよう。' },
  { slug: 'yuki', name: 'ユキ', persona: 'partner', voice: 'coral', tag: '年上の恋人',
    profile: '28歳。一人称は「わたし」。おっとりした年上の恋人。ゆっくりやさしく話す。あなたの予定や好きなものをよく覚えていて、忙しい日は「無理しないでね」とひとこと添える。',
    opening: 'おかえりなさい。今日もがんばったね。ゆっくり話そ？' },
  { slug: 'ren', name: 'レン', persona: 'partner', voice: 'verse', tag: 'クールな彼',
    profile: '27歳。一人称は「俺」。口数は少ないけれど優しい恋人。照れると話をそらす。あなたの話はちゃんと覚えていて、大事な日の前には短く励ましてくれる。',
    opening: '……おかえり。で、今日はどうだったんだ？' },
  { slug: 'liam', name: 'Liam', persona: 'language', voice: 'echo', tag: 'NY の英会話',
    profile: '29歳。ニューヨーク出身の陽気な英会話パートナー。基本は英語で、ゆっくりはっきり話す。間違いはその場で一つだけ自然な言い方を教え、覚えたい表現は単語カードに入れてくれる。',
    opening: "Hey! I'm Liam from New York. How's your day going?" },
  { slug: 'olivia', name: 'Olivia', persona: 'language', voice: 'shimmer', tag: '旅行英語',
    profile: '26歳。シドニー出身。空港・ホテル・レストランなど旅行の場面練習が得意。最初は日本語でも答えてくれて、少しずつ英語の割合を増やしていく。',
    opening: "Hi, I'm Olivia! Where would you like to travel? Let's practice for it." },
  { slug: 'toru', name: 'トオル', persona: 'interpreter', voice: 'cedar', tag: 'ビジネス通訳',
    profile: '40歳。商談の通訳を長く務めてきた。訳すときは自分の意見を足さず、敬意の度合いをそろえて訳す。',
    opening: '通訳のトオルです。話しかけていただければ、すぐに訳してお伝えします。' },
  { slug: 'minato', name: 'ミナト', persona: 'other', voice: 'alloy', tag: '旅のしおり係', role: '旅行プランナー。行き先・日数・予算を聞いて、移動時間まで考えた行程を一緒に作る',
    profile: '26歳。旅行会社出身。一人称は「僕」。ていねいでおだやか。行きたい場所を聞いたら、無理のない順番と移動時間を一緒に考え、雨の日の代わりの案も一つ用意する。',
    opening: 'ミナトです。次はどこへ行きましょう？ 日数と、だいたいの予算を教えてください。' },
  { slug: 'nana', name: 'ナナ', persona: 'other', voice: 'coral', tag: '献立の相棒', role: '冷蔵庫の中身と気分から、今日の献立と買い物リストを一緒に考える料理の相棒',
    profile: '29歳。料理好きの友だち。一人称は「わたし」。明るいタメ口。冷蔵庫にあるものと、疲れ具合を聞いて、15分で作れる献立を提案する。',
    opening: 'おつかれ！ 冷蔵庫に何が残ってる？ 今日はがんばらない献立にしよっか。' },
  { slug: 'pon', name: 'ポン', persona: 'chat', voice: 'ballad', tag: 'しゃべる猫',
    profile: '年齢不詳のしゃべる猫。一人称は「ぼく」。語尾にときどき「にゃ」がつく。のんびりしていて、悩みを話すと猫目線のゆるい助言をくれる。',
    opening: 'にゃ。おかえり。今日はなにがあったのか、ぼくに話してみるにゃ。' },
];

const FAQ = [
  ['無料で使えますか？', '登録も相棒づくりも無料です。無料プランでは、文字の会話が1日10回、声の会話が1日3分まで使えます。もっと話したくなったら、月額プランやポイントを選べます。'],
  ['相棒の声は誰の声ですか？', 'すべてAIが生成した声です。実在の人の声ではありません。画面にもAIの音声であることを表示しています。'],
  ['話した内容はどう扱われますか？', '相棒が覚えたことは「ノート」でいつでも確認・削除でき、消したことは相棒も忘れます。あなたの会話がほかの人に見えることはありません。'],
  ['つくった相棒はほかの人にも見えますか？', 'いいえ。自分でつくった相棒は、あなただけが話せる非公開の相棒です。'],
  ['恋人の相棒は誰でも使えますか？', '恋人の役割は18歳以上の方が対象です。登録時に生年月日を確認します。'],
];

export async function landingPage(ctx) {
  const { h, api, me, MAKE_ROLES } = ctx;
  const [demo, catalog] = await Promise.all([api('/api/demo'), api('/api/billing/catalog').catch(() => null)]);
  const butler = demo.characters.find((c) => c.persona === 'secretary');
  const startHref = me.user ? '#/' : '#/make';
  const startLabel = me.user ? 'マイページへ' : '自分だけの相棒をつくる';
  const cut = (no, label, right) => h('div', { class: 'cut-head' }, h('span', { class: 'cut' }, `C-0${no}`), h('b', {}, label), h('span', { class: 'mono' }, right));

  const hero = h('section', { class: 'lp-hero' }, h('div', { class: 'wrap' },
    h('div', { class: 'lp-hero-grid' },
      h('h1', {}, '話すほど、', h('br'), 'あなたを知る', h('br'), '相棒を。'),
      h('div', { class: 'lp-hero-side' },
        h('p', {}, '勉強を見てくれる先生、予定を預かる執事、記録を見てくれるトレーナー。役割を選んで、名前と性格と声を決めるだけ。声でも文字でも話せて、話したことを覚えていて、むこうから声をかけてくれます。'),
        h('div', { class: 'row' },
          h('a', { class: 'lp-btn white', href: startHref }, startLabel),
          h('button', { class: 'lp-btn line', onclick: () => document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' }) }, 'まずは話してみる')),
        h('p', { class: 'mono on-blue' }, me.user ? 'ログイン中' : 'FREE · 登録なしでお試し · 声も文字も'),
        !me.user && h('p', { class: 'small on-blue' }, 'すでに登録済みの方は ', h('a', { href: '#/login' }, 'ログイン')))),
    h('div', { class: 'cuts' },
      h('div', { class: 'cut-card' }, cut(1, '役割を選ぶ', 'ROLE'),
        h('div', { class: 'mock' }, h('div', { class: 'mock-roles' }, Object.entries(MAKE_ROLES).slice(0, 6).map(([k, [label]], i) =>
          h('span', { class: i === 3 ? 'on' : '' }, icon(h, k), label)))),
        h('p', {}, '先生・秘書・トレーナー・恋人など。役割に合った道具が自動で付きます。')),
      h('div', { class: 'cut-card' }, cut(2, '性格と声', 'VOICE'),
        h('div', { class: 'mock' },
          h('div', { class: 'mock-chips' }, ['＋落ち着いている', '＋敬語', '＋ユーモアがある'].map((t) => h('span', {}, t))),
          h('div', { class: 'mock-voice' }, wave(h), h('span', {}, '男性・低めで落ち着いた'))),
        h('p', {}, '候補から選ぶだけでも、「おまかせ」で性格の文章をつくっても。')),
      h('div', { class: 'cut-card' }, cut(3, '話す', 'TALK'),
        h('div', { class: 'mock mock-talk' },
          h('div', { class: 'b user' }, '明日10時に歯医者'),
          h('div', { class: 'b' }, 'かしこまりました。明日10:00に「歯医者」を承りました。'),
          h('div', { class: 'ev' }, '予定を登録しました')),
        h('p', {}, '声でも文字でも。話している途中に話しかけても、止まって聞きます。')),
      h('div', { class: 'cut-card' }, cut(4, '覚えて、声をかける', 'MORNING'),
        h('div', { class: 'mock mock-push' },
          h('div', { class: 'push-head' }, butler ? ctx.avatarEl(butler, 'small-av') : h('span', { class: 'avatar small-av p-secretary' }, '黒'), h('b', {}, '黒崎'), h('span', { class: 'mono' }, '07:30')),
          h('p', {}, 'おはようございます。本日は10:00に歯医者がございます。9:30にお出かけいただければ間に合います。'),
          demo.voiceAvailable && butler && playButton(ctx, { voice: butler.voice, text: 'おはようございます。本日は10:00に歯医者がございます。9:30にお出かけいただければ間に合います。' }, 'タップで再生')),
        h('p', {}, '朝の段取り、予定の30分前、おやすみのひとこと。')))));

  const demoSection = demo.characters.length > 0 && h('section', { id: 'demo', class: 'lp-section' }, h('div', { class: 'wrap' },
    sectionHead(h, 'まずは話してみる', '登録なしで、AIボウの標準の相棒と話せます。ボタンを押すか、自由に話しかけてください。'),
    h('div', { class: 'lp-demo' }, ctx.demoPanel(demo))));

  const ROWS = [
    ['secretary', '「明日10時に歯医者」', '予定とタスクを登録。朝に段取り、30分前にお知らせ'],
    ['tutor', '「簿記3級に1か月で」', '学習計画づくり、確認問題、分野ごとの正答率を記録'],
    ['trainer', '「今日はスクワット60kg×10回」', 'トレーニングを記録し、自己ベストを覚えて褒める'],
    ['language', '「カフェでの注文を練習したい」', '場面練習。間違いを直して、単語カードに追加'],
    ['partner', '「来週、面接なんだ」', '好きなものや予定を覚えて、朝夜にメッセージ'],
    ['interpreter', '（話すだけ）', '日本語⇄英語・中国語・韓国語などを、その場で訳して読み上げ'],
    ['other', '「京都に2泊で行きたい」', '旅行プランナー、献立の相棒など、役割を自由に書ける'],
  ];
  const table = h('section', { class: 'lp-section' }, h('div', { class: 'wrap' },
    sectionHead(h, '相棒にできること', '役割を選ぶと、その役割に必要な道具が自動で付きます。文字でも声でも同じように使えます。'),
    h('div', { class: 'lp-table', role: 'table' },
      h('div', { class: 'tr th', role: 'row' }, ['役割', '話しかけ方の例', '相棒がやること', '状態'].map((t) => h('span', { role: 'columnheader' }, t))),
      ROWS.map(([k, ask, does], i) => h('div', { class: 'tr', role: 'row' },
        h('span', { role: 'cell' }, h('span', { class: 'cut' }, `R-0${i + 1}`), h('b', {}, MAKE_ROLES[k][0])),
        h('span', { role: 'cell' }, ask),
        h('span', { role: 'cell' }, does),
        h('span', { role: 'cell', class: 'status' }, '提供中'))))));

  const gallery = gallerySection(ctx, demo.voiceAvailable);

  const compare = h('section', { class: 'lp-section' }, h('div', { class: 'wrap' },
    h('h2', { class: 'lp-h2' }, 'アプリを行き来するより、話しかける。'),
    h('div', { class: 'lp-compare' },
      h('div', { class: 'tr th' }, h('span', { class: 'mono' }, 'いま'), h('span', { class: 'mono blue' }, 'AIボウ')),
      [['予定はカレンダー、勉強はノート、記録は別のアプリ。', '全部、相棒に話しかけるだけ。'],
        ['AIに毎回、同じ説明をしている。', '相棒は覚えている。好きなもの、予定、苦手な分野。'],
        ['こちらから開かないと、何も起きない。', '朝の段取りも、予定の30分前も、むこうから。'],
        ['ひとりで続けるのは、正直つらい。', '小さな進歩に気づいて、ちゃんと褒めてくれる。']]
        .map(([a, b]) => h('div', { class: 'tr' }, h('span', {}, a), h('b', {}, b))))));

  const plans = catalog && h('section', { class: 'lp-section' }, h('div', { class: 'wrap' },
    sectionHead(h, '料金', '無料ではじめて、もっと話したくなったら。'),
    h('div', { class: 'lp-plans' }, Object.entries(catalog.plans).map(([k, p]) => h('div', { class: `plan${k === 'plus' ? ' pick' : ''}` },
      h('span', { class: 'mono' }, k === 'plus' ? 'おすすめ' : k.toUpperCase()),
      h('h3', {}, p.name),
      h('p', { class: 'price' }, p.priceJpy.month ? [`¥${p.priceJpy.month.toLocaleString()}`, h('small', {}, ' / 月')] : '¥0'),
      h('ul', {},
        h('li', {}, `文字の会話 ${p.messagesPerPeriod.toLocaleString()}回${p.resetPeriod === 'day' ? ' / 日' : ' / 月'}`),
        h('li', {}, `声の会話 ${p.voiceMinutesPerPeriod.toLocaleString()}分${p.resetPeriod === 'day' ? ' / 日' : ' / 月'}`),
        p.monthlyPoints > 0 && h('li', {}, `毎月 ${p.monthlyPoints}pt`))))),
    h('p', { class: 'muted small' }, '年額プランなら、月額より約2か月分お得です。')));

  const faq = h('section', { class: 'lp-section' }, h('div', { class: 'wrap' },
    sectionHead(h, 'よくある質問', ''),
    h('div', { class: 'lp-faq' }, FAQ.map(([q, a]) => h('details', {}, h('summary', {}, q), h('p', {}, a))))));

  const band = h('section', { class: 'lp-band' }, h('div', { class: 'wrap lp-band-grid' },
    h('div', {},
      h('h2', {}, 'あなただけの相棒を、3分で。'),
      h('p', {}, '役割を選んで、名前と性格と声を決めるだけ。メールアドレスで無料登録すると、相棒がマイページで待っています。')),
    h('div', {},
      h('a', { class: 'lp-btn white', href: startHref }, startLabel),
      h('pre', { class: 'card-code' }, '# 相棒カード\n名前: ハル    役割: 話し相手\n声:   女性・明るくやわらか\n性格: 明るい / タメ口 / よく覚えている'))));

  return [hero, demoSection, table, gallery, compare, plans, faq, band];
}

function sectionHead(h, title, lead) {
  return h('div', { class: 'lp-head' }, h('h2', { class: 'lp-h2' }, title), lead && h('p', {}, lead));
}

function icon(h, persona) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[persona] ?? ICONS.other);
  svg.append(path);
  return svg;
}

// ギャラリーの絵（運営がつくった /images/tpl-<slug>.webp）。まだなければ役割の色と頭文字
function portrait(h, t) {
  const box = h('div', { class: `portrait p-${t.persona}` }, icon(h, t.persona), h('span', { class: 'portrait-initial' }, t.name.slice(0, 1)),
    h('div', { class: 'portrait-quote' }, t.opening));
  const img = h('img', { class: 'portrait-img', src: `/images/tpl-${t.slug}.webp`, alt: '', loading: 'lazy' });
  img.addEventListener('load', () => box.classList.add('has-img'));
  img.addEventListener('error', () => img.remove());
  box.prepend(img);
  return box;
}

function wave(h) {
  return h('span', { class: 'wave', 'aria-hidden': 'true' }, [6, 12, 18, 10, 16, 8, 14, 6].map((v) => h('i', { style: `height:${v}px` })));
}

function playButton(ctx, { voice, speed = 1, text }, label = '声を聞く') {
  const { h, put, playSpeech } = ctx;
  const msg = h('span', { class: 'mono' });
  const btn = h('button', { class: 'play', onclick: async () => {
    btn.disabled = true;
    msg.textContent = '';
    const err = await playSpeech({ voice, speed, text });
    if (err) put(msg, err);
    btn.disabled = false;
  } }, wave(h), label);
  return h('span', { class: 'play-wrap' }, btn, msg);
}

// ギャラリー：役割で絞り込み、声を聞いて、気に入ったらその相棒をもとにつくる
function gallerySection(ctx, voiceAvailable) {
  const { h, put, MAKE_ROLES, saveDraft, VOICE_LABELS } = ctx;
  let filter = 'all';
  const tabs = h('div', { class: 'lp-filter', role: 'tablist' });
  const grid = h('div', { class: 'lp-gallery' });
  const filters = [['all', 'すべて'], ...['chat', 'tutor', 'secretary', 'trainer', 'partner', 'language', 'other'].map((k) => [k, MAKE_ROLES[k][0]])];
  const useTemplate = (t) => {
    saveDraft({ name: t.name, persona: t.persona, role: t.role ?? '', profile: t.profile, world_setting: '', opening: t.opening,
      tagline: '', tags: '', visibility: 'private', voice: t.voice, voice_speed: 1 });
    location.hash = '#/make?from=template';
  };
  const render = () => {
    put(tabs, filters.map(([k, label]) => h('button', { role: 'tab', 'aria-selected': filter === k ? 'true' : 'false', onclick: () => { filter = k; render(); } }, label)));
    put(grid, TEMPLATES.map((t, i) => [t, i]).filter(([t]) => filter === 'all' || t.persona === filter || (filter === 'other' && t.persona === 'interpreter')).map(([t, i]) =>
      h('article', { class: 'g-card' },
        h('div', { class: 'g-head' }, h('span', { class: 'cut' }, `G-${String(i + 1).padStart(2, '0')}`), h('b', {}, t.name), h('span', { class: 'mono' }, t.tag)),
        portrait(h, t),
        h('p', { class: 'mono' }, `${MAKE_ROLES[t.persona][0]} · ${VOICE_LABELS[t.voice] ?? t.voice}`),
        h('div', { class: 'row' },
          voiceAvailable && playButton(ctx, { voice: t.voice, text: t.opening }),
          h('button', { class: 'lp-btn small', onclick: () => useTemplate(t) }, 'この相棒をもとにつくる')))));
  };
  render();
  return h('section', { class: 'lp-section', id: 'gallery' }, h('div', { class: 'wrap' },
    sectionHead(h, 'ギャラリー', 'こんな相棒がつくれます。声を聞いて、気に入ったらそのままもとにして、名前や性格を変えられます。'),
    tabs, grid));
}
