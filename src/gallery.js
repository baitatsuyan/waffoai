// 公式の相棒とメインページのギャラリー（テンプレート）の見た目。運営が一度だけ絵をつくる（/api/admin/portraits）。
// ギャラリーの絵は /images/tpl-<slug>.webp に保存し、public/landing.js の TEMPLATES と slug で対応させる。

export const OFFICIAL_LOOKS = {
  'ミサキ': '21歳の女子大学生。肩までのやわらかい茶色の髪、細い丸眼鏡、ベージュのカーディガンに白いブラウス。教科書を胸に抱えている',
  '黒崎': '35歳の男性執事。黒髪をきちんと整え、黒い燕尾服に白い手袋、胸元に銀の懐中時計の鎖。落ち着いた微笑み',
  'カイ': '28歳の男性トレーナー。短い黒髪、日焼けした肌、スポーツウェアで首にタオル。明るい笑顔',
  'ミオ': '25歳の女性。セミロングの栗色の髪、オフホワイトのゆるいニット。少しはにかんだ笑顔',
  'Emma': '26歳のイギリス人女性。金髪のボブ、ベージュのトレンチコート、カフェの窓辺',
  'リン': '29歳の女性通訳者。黒髪のまとめ髪、紺のスーツ、片耳にヘッドセット',
};

export const TEMPLATE_LOOKS = {
  haru: { name: 'ハル', persona: 'chat', looks: '24歳の女性。明るい栗色のポニーテール、パーカー、元気な笑顔' },
  souta: { name: 'ソウタ', persona: 'tutor', looks: '23歳の男性大学院生。少し無造作な黒髪、シャツにネイビーのカーディガン、ノートとペン' },
  sae: { name: 'サエ', persona: 'secretary', looks: '31歳の女性秘書。黒髪のストレートロング、グレーのスーツ、タブレットを持つ' },
  ryu: { name: 'リュウ', persona: 'trainer', looks: '30歳の男性。短髪、引き締まった体、Tシャツ姿でボクシンググローブを肩に掛けている' },
  yuki: { name: 'ユキ', persona: 'partner', looks: '28歳の女性。長い黒髪をゆるくまとめ、白いニット、穏やかな笑顔' },
  ren: { name: 'レン', persona: 'partner', looks: '27歳の男性。少し長めの黒髪、黒いジャケット、クールだけれどわずかに微笑む' },
  liam: { name: 'Liam', persona: 'language', looks: '29歳のニューヨーク出身の男性。短い茶髪、デニムジャケット、陽気な笑顔' },
  olivia: { name: 'Olivia', persona: 'language', looks: '26歳のオーストラリア出身の女性。ウェーブのかかった金髪、旅行用のリュック、空港のロビー' },
  toru: { name: 'トオル', persona: 'interpreter', looks: '40歳の男性通訳者。短く整えた髪、紺のスーツ、片耳にヘッドセット' },
  minato: { name: 'ミナト', persona: 'other', looks: '26歳の男性。やわらかい黒髪、カジュアルなシャツ、旅行の地図を広げている' },
  nana: { name: 'ナナ', persona: 'other', looks: '29歳の女性。ショートヘア、エプロン姿、明るいキッチン' },
  pon: { name: 'ポン', persona: 'chat', looks: 'ふわふわの茶トラの猫。大きな丸い目、首に小さな鈴。人間ではなく猫そのもの' },
};
