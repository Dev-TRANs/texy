# text-proxy

Cloudflare Workers上で動く、テキスト抽出プロキシ。
`https://<デプロイ先>/<対象URL>` にアクセスすると、対象ページの本文をReadabilityで抽出し、画像・動画・iframeを除去したHTMLを返す。

## 使い方（デプロイ後）

```
https://proxy.stki.org/https://www.yahoo.co.jp/xxx/yyy
```

## デプロイ手順

1. Node.js / npm がある環境で:

```bash
npm install
npx wrangler login
```

2. `wrangler.toml` の `routes` を有効化し、`stki.org` を実際に使う独自ドメイン名に差し替える
   （事前にそのドメインをCloudflareのゾーンとして追加しておく必要がある）

3. デプロイ:

```bash
npx wrangler deploy
```

4. 独自ドメインを使わずテストするだけなら、`routes` はコメントアウトしたまま:

```bash
npx wrangler deploy
```

とすると `text-proxy.<あなたのサブドメイン>.workers.dev` が発行されるので、
まずそこで動作確認してから独自ドメインを割り当てるのがおすすめ。

## 制限事項

- JavaScriptで本文を描画するSPA系サイト（ReactなどでレンダリングされるSSRなしのサイト）は
  本文抽出に失敗することがある。その場合はエラーメッセージと元URLのみ返す。
- Readability/linkedomの処理はCPU時間を消費するため、無料プランのCPU時間上限
  （リクエストあたり10ms、Bundled）に注意。長大なページや複雑なDOMだと超える場合があるので、
  実運用ではCPU time制限の緩いUnboundプラン、または処理をシンプルにする調整が必要になることがある。
