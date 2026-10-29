# AIボウ

声で話せる AI キャラクターの UGC プラットフォームです。クリエイターがキャラを公開し、ユーザはそのキャラと声や文字で話します。
キャラは「基本ペルソナ（役割）」×「個性」でできていて、トレーナー・資格の先生・秘書・恋人・語学パートナー・同時通訳者などの役割は、
会話の中で予定や記録を扱う道具を持ちます。収益はサブスク＋ポイント課金で、売上の一部をクリエイターに還元します。

## 画面の構成

いまは一般ユーザー（自分で使う人）向けの体験を中心にしています。クリエイター向けの画面は別の入口に分けました。

| 画面 | 内容 |
|---|---|
| ホーム（`#/`） | わたしの相棒、今日と明日の予定・タスク、届いたメッセージ、すぐ話しかけるボタン。はじめての人は公式の相棒を選ぶところから |
| さがす（`#/discover`） | 公式の相棒とみんなのキャラ。気に入ったら「相棒にする」 |
| トーク（`#/talk`） | 相棒と声で話す（1対1・みんなで・通訳） |
| ノート（`#/notes`） | 相棒が覚えたこと・記録したこと |
| お知らせ（`#/inbox`） | 相棒からのメッセージと通知の設定 |
| 設定（`#/settings`） | プラン、相棒の管理、生年月日、ログアウト、クリエイター画面への入口 |
| クリエイター（`#/creator`） | キャラの作成・編集・公開中の調整・報酬（準備中の機能を含む） |

公式の相棒（シオン・カイ・ユイ先生・ミオ・Emma・リン）は起動時に `src/seed.js` から作られます。

## できること

- **声で話す（リアルタイム音声）**：1対1は speech-to-speech。話している途中に話しかけると止まって聞く（割り込み）
- **複数キャラと同時に話す**：最大4人。名前を呼んだキャラが答え、「みんな」なら全員が順番に答える。キャラごとに声が違う
- **同時通訳**：「わたしが話す／相手が話す」を切り替えて、日本語⇄英語・中国語・韓国語などを訳して読み上げる
- **道具（ツール）**：記憶、予定・タスク、トレーニング記録（自己ベスト）、小テストの結果、単語カード。文字でも声でも同じ道具を使う
- **ノート**：キャラが覚えたこと・記録したことを一覧。消すとキャラも忘れる。記憶ごとに「全キャラで共有」を選べる
- **調整**：プロンプトで性格・話し方を微修正。作成者は公開中のキャラに、ほかの人は自分用に。版の保存・戻し、調整前後の比較
- **キャラからのメッセージ**：朝・夜のメッセージと予定30分前のお知らせ（受信箱＋Web Push）
- **安全**：危機的な発言には相談窓口を表示、恋人ペルソナは18歳以上（生年月日）、長時間の利用には休憩をすすめる、通訳は注意書きを表示、AI音声であることを表示

競合（MyChara / nyaan）の調査結果と設計の根拠は [docs/business-analysis.md](docs/business-analysis.md) を参照してください。

## 起動

Node.js 22.5 以上が必要です（組み込みの `node:sqlite` を使用）。

```bash
npm install
npm start          # http://localhost:3000
npm test
```

API キーがなくても動きます。LLM 未設定ならモックで返答し、ログインリンクは画面に表示されます（本番ではメールで送り、画面にもログにも出しません）。
音声は `OPENAI_API_KEY` を設定すると使えます。ブラウザのマイクは HTTPS か localhost でしか使えません。

## Render へのデプロイ

`render.yaml`（Blueprint）で、シンガポールリージョンの Web サービス（Starter）＋1GB のディスクを作ります。

1. Render の Dashboard で **New → Blueprint** を選び、このリポジトリをつなぐ
2. 入力を求められた環境変数（`sync: false` のもの）に値を入れる。最低限 `RESEND_API_KEY` と `MAIL_FROM`（ログイン用）、音声を使うなら `OPENAI_API_KEY`
3. デプロイ後、`https://<サービス名>.onrender.com/healthz` が `ok` を返すことを確かめる
4. Waffo Dashboard の通知先を `https://<公開URL>/api/waffo/webhook` に設定する

- SQLite は `/var/data/aibow.db`（ディスク）に保存されます。ディスクの外に書いたファイルはデプロイのたびに消えます
- ディスクを付けたサービスは1台構成で、デプロイ中は数十秒止まります。利用者が増えたら DB を Postgres に移して複数台にする
- ディスクは Render が毎日スナップショットを取ります。念のため、定期的に DB のバックアップも取ってください

## 環境変数

| 変数 | 用途 |
|---|---|
| `BASE_URL` | 公開 URL（ログインリンク・決済後の戻り先・Webhook の URL）。Render では未設定なら `RENDER_EXTERNAL_URL` を使う |
| `RESEND_API_KEY` / `MAIL_FROM` | ログインリンクのメール送信（[Resend](https://resend.com)）。本番ではこれがないとログインできない |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 互換 API。例：OpenRouter は `https://openrouter.ai/api/v1`、BytePlus ModelArk は管理画面に表示されるエンドポイント |
| `OPENAI_API_KEY` | リアルタイム音声（OpenAI Realtime API）と声のお試し（TTS） |
| `REALTIME_MODEL` / `TRANSCRIBE_MODEL` / `TRANSLATE_MODEL` / `TTS_MODEL` | 既定は `gpt-realtime-2.1` / `gpt-live-transcribe` / `gpt-realtime-translate` / `gpt-4o-mini-tts` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push（`npx web-push generate-vapid-keys` で作る）。なければ受信箱のみ |
| `WAFFO_API_KEY` / `WAFFO_MERCHANT_ID` | Waffo の API キーと加盟店 ID |
| `WAFFO_PRIVATE_KEY` | 加盟店の秘密鍵（Base64 の PKCS8 DER、または PEM）。リクエストと Webhook 応答の署名に使う |
| `WAFFO_PUBLIC_KEY` | Waffo の公開鍵（Dashboard の Integration に表示）。Webhook の署名検証に使う |
| `WAFFO_ENV` | `sandbox`（既定）または `production` |
| `ADMIN_EMAILS` | 運営用レポートを見られるメールアドレス（カンマ区切り） |
| `DB_PATH` | SQLite ファイル（既定 `data/aibow.db`） |
| `NODE_ENV=production` | 本番モード（ログインリンクを画面に出さない） |

### リアルタイム音声のしくみ

```
1対1   マイク ──WebRTC──▶ キャラのセッション（speech-to-speech・VAD・道具）──▶ スピーカー
グループ マイク ──▶ 耳のセッション（聞き取りのみ）── 文字 ──▶ ブラウザが答えるキャラを決める
                                                          └─▶ キャラ A の声セッション ─▶ スピーカー
                                                          └─▶ キャラ B の声セッション ─▶ スピーカー（順番に）
通訳   マイク ──▶ 翻訳セッション（方向を session.update で切り替え）──▶ スピーカー
```

- ブラウザの SDP をサーバが受け取り、指示文・声・道具を付けて `/v1/realtime/calls` に送る（API キーはブラウザに渡さない）
- 課金は分単位：開始時に1分、以後は20秒ごとのハートビートで経過分を請求。残高切れ・60分・90秒無応答で、サーバが `hangup` で切る
- グループは参加キャラ数ぶん課金（聞き取りの耳は無料）。キャラの道具はデータチャネルの function call をサーバに転送して実行する
- 通訳は短命のクライアントキーで翻訳セッションにつなぐ（翻訳セッションはサーバから切れないため、キーは60秒で失効）

### 決済（決済代行：Waffo）

[Waffo の Node.js SDK](https://waffo.com/docs/en/developer-docs/sdk/nodejs.md) で連携しています。

- ポイント購入：単発決済（`order/create`）。決済画面から戻ったら `order/inquiry` でも結果を確認する
- プラン：Waffo 管理のサブスク（`subscription/create`）。月額は 1か月ごと、年額は 12か月ごとに自動更新
- 解約は `subscription/cancel`、支払い方法の変更は `subscription/manage` の管理ページ
- 権利（ポイント・プラン）は Webhook で支払い成功を確認してから付与する。金額・通貨が注文と違えば付与しない

Webhook の URL は `{BASE_URL}/api/waffo/webhook` です。注文作成時に `notifyUrl` として渡すほか、**返金とチャージバックの通知先を Waffo Dashboard で同じ URL に設定**してください。処理する通知は次のとおりです。

| 通知 | 処理 |
|---|---|
| `PAYMENT_NOTIFICATION` | ポイント付与。サブスクの各期間の支払いなら期間を延ばして特典ポイントを付与 |
| `SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION` | 期間ごとの最終結果。支払い成功が確認できた期間を反映 |
| `SUBSCRIPTION_STATUS_NOTIFICATION` | 解約・終了の反映（支払い済み期間の終わりまでは利用可） |
| `REFUND_NOTIFICATION` | 返金額の割合に応じて、その購入の有償ポイントを失効 |
| `CHARGEBACK_NOTIFICATION` | その購入の有償ポイントを失効 |

通知は順不同・重複ありで届くため、処理はすべて冪等です。処理に失敗したら `{"message":"failed"}` を返し、Waffo に再送させます。

Sandbox で試すときは、ローカルを `cloudflared tunnel --url http://localhost:3000` などで公開して `BASE_URL` に設定します。サブスクの更新は、管理ページの「次回支払いを成功/失敗させる」ボタンで再現できます。

## 構成

```
src/
  config.js           料金・プラン・ポイント単価・還元率（数値はここだけ）
  db.js               SQLite スキーマ
  auth.js             マジックリンク認証とセッション
  app.js              API ルート
  billing/points.js   有償／無償ポイントの台帳
  billing/plans.js    プラン枠と課金（枠 → ポイントの順）
  billing/rewards.js  クリエイター報酬と出金申請
  billing/waffo.js    Waffo 決済（注文・サブスク作成、Webhook 処理）
  personas.js         基本ペルソナ（役割・使える道具）と声の一覧
  prompt.js           キャラ設定・調整・記憶から指示文を組み立てる
  tools.js            キャラが使う道具（文字・声で共通）
  realtime.js         OpenAI Realtime への接続とセッション設定（1対1・耳・声）
  proactive.js        キャラからのメッセージ（朝・夜・リマインド）と Web Push
  safety.js           危機的な発言の検知、年齢確認、長時間利用の声かけ
  routes/voice.js     音声セッション・分単位課金・切断
  routes/companion.js 記憶・記録・調整・お知らせ・通知の API
  routes/home.js      相棒（user_companions）とホーム画面の API
  seed.js             公式の相棒
  llm/provider.js     LLM 呼び出し（function calling 対応）
public/
  app.js              画面（SPA）
  voice.js            ブラウザの音声クライアント（WebRTC）
  talk-logic.js       誰が答えるかのルール
  sw.js               通知用 Service Worker
test/                 node:test によるテスト
```

## 本番公開前にやること

- `public/legal.html` の〔 〕を実際の事業者情報で埋める。利用規約とプライバシーポリシーを用意する
- 通報機能とコンテンツモデレーション（決済事業者の規約への対応）
- Waffo の本番環境：加盟店公開鍵の登録、返金・チャージバック通知 URL の設定、受け入れテスト（Waffo の Integration acceptance criteria）
- 有償ポイントの未使用残高を監視する（資金決済法）
- 実際のマイク・スピーカーで、遅延・割り込み・グループの順番取りを確かめる（自動テストは偽の WebRTC で画面の流れまで）
- 年齢確認を外部サービスに置き換える（いまは自己申告の生年月日）
