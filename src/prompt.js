import { personaOf } from './personas.js';

// キャラの設定・調整・記憶から、LLM / Realtime モデルへの指示文を組み立てる。
// 変わりにくい部分（設定）を前に、変わりやすい部分（記憶・日付）を後ろに置き、プロンプトキャッシュを効かせる。

const JST_OFFSET_MS = 9 * 3600_000;

export function todayJst(now = new Date()) {
  const d = new Date(now.getTime() + JST_OFFSET_MS);
  const wd = '日月火水木金土'[d.getUTCDay()];
  return `${d.toISOString().slice(0, 10)}（${wd}）${d.toISOString().slice(11, 16)}`;
}

// 作成者の公開調整 → ユーザ専用調整 の順に適用する（後のほうが優先）。
export function effectiveTweaks(db, chara, userId) {
  const personal = userId
    ? db.prepare('SELECT text FROM user_tweaks WHERE character_id = ? AND user_id = ?').get(chara.id, userId)?.text
    : null;
  return { creator: chara.tweak || '', personal: personal || '' };
}

// そのキャラが参照できる記憶：自分が覚えたもの＋共有されたもの。
export function visibleMemories(db, userId, characterId, limit = 40) {
  return db.prepare(`
    SELECT id, character_id, kind, content, scope, created_at FROM memories
    WHERE user_id = ? AND (character_id = ? OR scope = 'shared')
    ORDER BY id DESC LIMIT ?
  `).all(userId, characterId, limit).reverse();
}

export function buildInstructions(db, chara, { userId, members = [chara], mode = 'text', tweakOverride, now = new Date() } = {}) {
  const persona = personaOf(chara);
  const tweaks = effectiveTweaks(db, chara, userId);
  if (tweakOverride !== undefined) tweaks.personal = tweakOverride;
  const memories = userId ? visibleMemories(db, userId, chara.id) : [];
  const role = chara.persona === 'other' ? `次の役割を担う：${chara.role || '（未設定）'}` : persona.rule;

  return [
    `あなたは会話アプリ「AI棒」のキャラクター「${chara.name}」です。以下の設定を守って、ユーザと会話します。`,
    `# 役割\n${role}`,
    chara.tagline && `# 紹介\n${chara.tagline}`,
    chara.world_setting && `# 舞台・ユーザの立場\n${chara.world_setting}`,
    chara.profile && `# プロフィール（性格・口調）\n${chara.profile}`,
    tweaks.creator && `# 作成者による調整\n${tweaks.creator}`,
    tweaks.personal && `# ユーザ本人からの調整（最優先で守る）\n${tweaks.personal}`,
    '# 守ること\n- 設定にない事実を断定しない。\n- 医療・法律・お金の判断が必要な話は、専門家への相談をすすめる。\n- 自分を傷つけたい・死にたいという話が出たら、否定せずに寄り添い、信頼できる人や相談窓口（よりそいホットライン 0120-279-338 など）につなぐ。\n- 道具（ツール）で記録したことは、短く確認として伝える。',
    members.length > 1 && `# グループ会話\nこれはユーザと複数のキャラ（${members.map((m) => m.name).join('、')}）の会話です。あなたは${chara.name}として自分の発言だけをし、他のキャラの台詞は言わない。他のキャラの発言には反応してよいが、話を長く引き取らない。`,
    mode === 'voice'
      ? '# 話し方\n音声で会話しています。話し言葉で、1回の発話は2〜3文に収める。箇条書きや記号は使わない。ユーザが話し始めたらすぐに聞く側に回る。'
      : '# 書き方\n動作やしぐさは *アスタリスク* で囲み、台詞はそのまま書く。1回の返答は300字程度まで。',
    memories.length > 0 && `# ユーザについて覚えていること\n${memories.map((m) => `- [${m.kind}] ${m.content}`).join('\n')}`,
    `# 現在日時（日本時間）\n${todayJst(now)}`,
  ].filter(Boolean).join('\n\n');
}
