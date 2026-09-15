# Contributing to KOAN Plus

KOAN Plus は大阪大学のKOAN/CLEに接続するローカル完結型の拡張機能です。
変更を送る前に、利用者の学務情報と認証情報をリポジトリへ持ち込まないことを
最優先にしてください。

プロジェクトの目的と、UI・同期・長期運用の判断基準は
[DEVELOPMENT.md](./DEVELOPMENT.md) にまとめています。
開発エージェント向けの要点は [AGENTS.md](./AGENTS.md) を参照してください。

## 開発環境

- Node.jsの対応範囲は [package.json](./package.json) の `engines.node`、ローカル開発用の版は [.nvmrc](./.nvmrc) を参照
- npmは `package.json` の `packageManager` に合わせる
- UI E2Eには、検証対象に応じてPlaywright用のChromiumまたはFirefoxを導入

初回セットアップやlockfile変更後の依存関係の導入には、次を使います。

```sh
npm ci
```

## 変更に応じた検証

変更の影響に応じて、次から該当する検証を選びます。

| 変更 | 検証 |
| --- | --- |
| ビルド入力に含まれない文書・エージェント指示のみ | 相対リンク、記載コマンド、画面ラベル、日英の説明の整合性と `git diff --check`。アプリのテスト・ビルドは不要 |
| アプリコード・拡張スクリプト・依存関係・ビルド設定 | `npm run typecheck`、`npm test`、`npm run build` |
| UI・CSS・画面内の文言 | コード変更の検証に加え、影響する画面のUI E2Eと実表示の確認 |
| 初回設定画面に取り込まれる `PRIVACY.md`・`TERMS.md` | 画面内の文言変更として検証し、規約・プライバシー説明の表示を確認 |
| 同期・取得・保存 | コード変更の検証で、正常な0件、一部取得、構造変化、セッション切れ、ページ送りの停止・再開、失敗時のキャッシュ保持のうち影響するケースを確認 |
| Firefox対応・共通の拡張API | コード変更の検証に加え、[Firefox対応の確認](#firefox対応の確認) |
| 配布物に含めるライセンス・通知文書 | 対象ブラウザのビルドと、生成した配布物への同梱確認 |

UI E2Eは初回に必要なブラウザを導入します。以下はChromiumの例です。

```sh
npx playwright install chromium
npm run test:ui
```

対象を絞る場合は、例えば `npm run test:ui -- tests/ui-ux-regressions.e2e.ts` のようにファイルを指定できます。共通レイアウトや複数画面へ影響する変更では、その範囲を含めて選びます。UIの状態別の確認観点は [デスクトップUI仕様](./docs/desktop-ui-direction.md#検証方法) にあります。CSSを削るときは、文字列検索だけで未使用と判断せず、動的に生成されるクラス名と実表示を確認します。

既存の単体・UIテストは合成データと模擬した通信・ブラウザAPIを使い、大学アカウントを必要としません。依頼範囲のローカル修正、テスト実行、失敗の修正と再検証は、各段階で確認を求めず進められます。依存関係やブラウザの初回導入にはネット接続が必要です。

CI一式を再現する場合は [.github/workflows/ci.yml](./.github/workflows/ci.yml) を参照してください。ローカルで選ぶ検証と、PRで実行されるCIは区別します。同じ変更で完了した検証は、新しい変更・失敗・未解決の懸念がある場合に再実行します。

完了時は、実施した検証と未確認の範囲を報告します。自動テストは、実サーバーでの認証・情報取得の成功を保証しません。実環境での確認が必要な変更で未実施なら、具体的な手順を示します。CLEメッセージは [確認手順](./docs/cle-message-verification.md) を参照してください。

コミットやPRへ含める差分では、生成物・認証情報・個人情報の混入も確認します。pushの可否は [AGENTS.md](./AGENTS.md#作業範囲と完了) の指定に従います。

```sh
git diff --check
git status --short
git diff --stat
```

## Firefox対応の確認

Firefox対応や共通の拡張APIを変更する場合は、次を実行します。ブラウザの導入は初回のみです。

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
- fixtureを追加・変更した場合は、合成データであることを明記する
- [変更に応じた検証](#変更に応じた検証) で選んだ検証の結果と、未実施項目があれば理由を記載する
- 生成物（`dist/`、`playwright-report/`、`test-results/`、zip、trace）をコミットしない
- 第三者のコード・アイコン・素材を追加する場合は、出典とライセンスを [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) に記録する。`npm run build` は依存関係のライセンス原文を配布物へ同梱し、原文が欠けている場合は失敗する

Pull RequestのCIは、同じブランチの新しい実行が開始されたときに古い実行をキャンセル
します。古い実行の結果だけを根拠にマージしないでください。

## 公開文書の更新

画面名・操作・機能を変更した場合は、影響する記載を次から選んで更新します。

- [README.md](./README.md) と [README.en.md](./README.en.md)：機能、導入方法、データの扱い
- [使い方](./docs/user-guide.md)：実際の画面ラベルと操作手順
- [CHANGELOG.md](./CHANGELOG.md)：未公開の変更は `Unreleased` に記載
- [デスクトップUI仕様](./docs/desktop-ui-direction.md)：画面と操作の設計
- [同期仕様](./docs/sync-policy.md) と [英語版](./docs/sync-policy.en.md)：更新間隔、キャッシュ、再試行
- [Chrome Web Store掲載文案](./docs/chrome-web-store.md)：次回公開するビルドと機能説明の一致

掲載文に未公開の機能を混ぜず、最上級表現や保証できない取得精度をうたわないでください。
スクリーンショットや使用例には合成データを使い、実在する認証情報や学務データを含めないでください。
