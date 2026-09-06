# Contributing to KOAN Plus

KOAN Plus は大阪大学のKOAN/CLEに接続するローカル完結型の拡張機能です。
変更を送る前に、利用者の学務情報と認証情報をリポジトリへ持ち込まないことを
最優先にしてください。

プロジェクトの目的と、UI・同期・長期運用の判断基準は
[DEVELOPMENT.md](./DEVELOPMENT.md) にまとめています。
開発エージェント向けの要点は [AGENTS.md](./AGENTS.md) を参照してください。

## 開発環境

- Node.js `20.19.x` または `22.12.x` 以上の対応系列
- npm（`package-lock.json` と同じバージョン系列を推奨）
- UI E2Eを実行する場合はPlaywrightがサポートするChromium

依存関係は、再現性のため `npm install` ではなく次で導入します。

```sh
npm ci
```

## 変更前のチェック

最低限、次を実行してください。

```sh
npm run typecheck
npm test
npm run build
```

UI E2Eを含める場合は、初回だけChromiumを導入してから実行します。

```sh
npx playwright install chromium
npm run test:ui
```

CIと同じ順序をローカルで確認する場合は、次を順番に実行してください。

```sh
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:ui
```

push前には、生成物・認証情報・個人情報が混入していないことも確認します。

```sh
git diff --check
git status --short
git diff --stat
```

## Firefox対応の確認

Firefox対応を変更する場合は、通常のチェックに加えて次を実行します。

```sh
npm run zip:firefox
npx playwright install firefox
npm run test:ui:firefox
npx web-ext lint --source-dir dist-firefox
```

Chrome用は `dist/` / `koan-plus.zip`、Firefox用は `dist-firefox/` / `koan-plus-firefox.zip` へ出力します。両方にライセンスを同梱します。
PlaywrightのFirefoxテストは合成データによるWeb UI検証です。拡張機能の権限ダイアログや大学サービスでの認証確認は [Firefox確認手順](./docs/firefox-verification.md) に沿って別に行ってください。

## テストfixtureと個人情報

実在のKOAN/CLEデータをfixture、スクリーンショット、ログ、スナップショット、
サンプルHTMLとして追加してはいけません。次の情報をコミットしないでください。

- 学内ID、氏名、学生番号、メールアドレス、パスワード
- TOTPシークレット、一時解除コード、セッションCookie、認証ヘッダー
- 実在するKOAN/CLE URLのセッションパラメータや個人を識別できるID
- 成績、履修情報、掲示本文、CLEメッセージ本文、資料URL
- `localStorage` / IndexedDB / Chrome profile のエクスポート
- 実在アカウントで取得したPlaywright trace、video、screenshot、HTML

fixtureは、合成した日本語・ダミーID・無効化したURLだけで作成してください。
テストの失敗ログをIssueやPull Requestへ貼る前に、上記の情報と認証状態がないことを
確認してください。

## セキュリティ

認証情報、個人情報、XSS、権限、拡張機能の挙動に関する脆弱性は、公開Issueに
詳細を書かず、[SECURITY.md](./SECURITY.md) の報告手順を使ってください。
脆弱性を再現するコードが必要な場合も、実データではなく最小の合成fixtureを
使用します。

依存関係を更新する場合は、`package-lock.json` も同じ変更に含め、直接依存・推移依存・
Node対応範囲を確認してください。DOMPurifyのような入力処理ライブラリは、修正版を
優先し、セキュリティ修正を理由なく保留しないでください。
Dependabotの更新PRもlockfileを確認し、CIの完了後に手動レビューして取り込んでください。

## Pull Requestの方針

- 目的と変更範囲を本文の冒頭に書く
- UI、スクレイパー、保存データに影響する場合は、失敗時の挙動と後方互換性を説明する
- テストfixtureに個人情報がないことを明記する
- `npm run typecheck`、`npm test`、`npm run build` の結果を記載する
- UI変更では、必要に応じてChromium E2Eの結果と失敗時のスクリーンショットを確認する
- 生成物（`dist/`、`playwright-report/`、`test-results/`、zip、trace）をコミットしない
- 第三者のコード・アイコン・素材を追加する場合は、出典とライセンスを [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) に記録する。`npm run build` は依存関係のライセンス原文を配布物へ同梱し、原文が欠けている場合は失敗する

Pull RequestのCIは、同じブランチの新しい実行が開始されたときに古い実行をキャンセル
します。古い実行の結果だけを根拠にマージしないでください。

## 公開文書の更新

画面名や操作、機能が変わる場合は、次の文書も確認してください。

- [README.md](./README.md) と [README.en.md](./README.en.md)：機能、導入方法、データの扱い
- [使い方](./docs/user-guide.md)：実際の画面ラベルと操作手順
- [CHANGELOG.md](./CHANGELOG.md)：未公開の変更は `Unreleased` に記載
- [デスクトップUI仕様](./docs/desktop-ui-direction.md)：画面と操作の設計
- [同期仕様](./docs/sync-policy.md) と [英語版](./docs/sync-policy.en.md)：更新間隔、キャッシュ、再試行
- [Chrome Web Store掲載文案](./docs/chrome-web-store.md)：次回公開するビルドと機能説明の一致

掲載文に未公開の機能を混ぜず、最上級表現や保証できない取得精度をうたわないでください。
スクリーンショットや使用例には合成データを使い、実在する認証情報や学務データを含めないでください。
文書だけの変更でも、相対リンク、画面ラベル、コマンド、日英の説明に矛盾がないかを確認します。
