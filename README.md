# Waffo

AIキャラクターと会話できる UGC プラットフォームの MVP です。クリエイターがキャラ設定を公開し、ユーザはそのキャラと AI で会話します。収益はサブスク＋ポイント課金で、売上の一部をクリエイターに還元します。

競合（MyChara / nyaan）の調査結果と設計の根拠は [docs/business-analysis.md](docs/business-analysis.md) を参照してください。

## 起動

Node.js 22.5 以上が必要です（組み込みの `node:sqlite` を使用）。

```bash
npm install
npm start          # http://localhost:3000
npm test
```

API キーがなくても動きます。LLM 未設定ならモックで返答し、ログインリンクは画面に表示されます（本番では非表示）。

## 環境変数

| 変数 | 用途 |
|---|---|
| `BASE_URL` | 公開 URL（ログインリンク・Stripe の戻り先） |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 互換 API。例：OpenRouter は `https://openrouter.ai/api/v1`、BytePlus ModelArk は管理画面に表示されるエンドポイント |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe の決済と Webhook |
| `ADMIN_EMAILS` | 運営用レポートを見られるメールアドレス（カンマ区切り） |
| `DB_PATH` | SQLite ファイル（既定 `data/waffo.db`） |
| `NODE_ENV=production` | 本番モード（ログインリンクを画面に出さない） |

Stripe の Webhook エンドポイントは `/api/stripe/webhook` です。受け取るイベントは次のとおりです。
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `charge.refunded`, `charge.dispute.created`

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
  billing/stripe.js   Checkout と Webhook 処理
  llm/provider.js     キャラ設定からプロンプトを作り、LLM を呼ぶ
public/               依存なしのフロントエンド（SPA）と特商法表記のひな形
test/                 node:test によるテスト
```

## 本番公開前にやること

- メール送信サービスをつないで、ログインリンクをメールで送る（`src/app.js` の TODO）
- `public/legal.html` の〔 〕を実際の事業者情報で埋める。利用規約とプライバシーポリシーを用意する
- 通報機能とコンテンツモデレーション（Stripe 規約への対応）
- 有償ポイントの未使用残高を監視する（資金決済法）
