# Firefox Add-onsへの公開（1.6.0）

Firefox Add-ons（AMO）への提出に使うファイルと操作を説明します。以下の生成例は、2026-09-06に用意した `v1.6.0` タグの候補を再現するものです。記録上の提出・公開状況は [変更履歴](../CHANGELOG.md) を参照してください。

## 用意するファイル

| ファイル | 用途 |
| --- | --- |
| `koan-plus-1.6.0-firefox.zip` | AMOの拡張機能本体のアップロード欄 |
| `koan-plus-1.6.0-source.zip` | 審査用ソースコードのアップロード欄。`BUILDING.md`とlockfileを含む |

本体ZIPと審査用ソースZIPには、同じコミットのコードを使います。既存の配布ZIPとタグは保持し、再現用ファイルは空の作業フォルダへ出力してください。

まず、リポジトリで対象タグのソースZIPを作成します。出力名のファイルが既にある場合は、既存ファイルを上書きしない別の出力先を指定します。

```sh
git archive --format=zip --prefix=koan-plus-1.6.0/ --output=koan-plus-1.6.0-source.zip v1.6.0
```

このZIPを空の作業フォルダへ展開します。展開した `koan-plus-1.6.0/` に移動し、同梱の `BUILDING.md` に記録されたNode.js・npmを用意してから、次を実行します。

```sh
npm ci
npm run build:firefox
node scripts/build-zip.mjs dist-firefox ../koan-plus-1.6.0-firefox.zip
```

新しいコミットから候補を作る場合も、そのコミットのソースZIPを展開してビルドし、ビルド環境と検証結果を記録します。作業フォルダ全体や `node_modules`、`.env`、ブラウザプロファイルをソースZIPへ含めないでください。Chrome版の提出物は [Chrome提出記録](./chrome-submission-1.6.0.md) にあり、このFirefox候補とはソースが異なります。

Viteで変換・結合したコードを配布するため、Mozillaには対応する元のソースと再ビルド手順の提出が必要です。[Mozilla: Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)

## ストアでの操作

1. [Add-ons Developer Hub](https://addons.mozilla.org/developers/)へMozillaアカウントでログインし、新しいアドオンを提出します。
2. 配布方法は **On this site**（AMO上で公開）を選びます。
3. 本体欄に `koan-plus-1.6.0-firefox.zip` をアップロードします。検証結果を確認し、対応プラットフォームはデスクトップを指定します。Androidは対象外です。
4. ソースコードを提供する選択肢で **Yes** を選び、`koan-plus-1.6.0-source.zip` を添付します。
5. 名前、概要、説明、カテゴリ、サポート先、MITライセンス、プライバシーポリシーを入力します。プライバシー説明は [PRIVACY.md](../PRIVACY.md) に合わせます。
6. 下記の審査員向け説明を記入し、内容を見直して **Submit Version** を押します。その後の状態・追加確認はAMOとメールで確認します。

公開後の更新は、同じアドオンの管理ページから新しいバージョンを追加します。拡張ID `@koan-plus.haze-355` は変更しません。[Mozilla: Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)

## 掲載文案

名前：**KOAN Plus**

概要：大阪大学のKOAN・CLEの授業、締切、連絡、成績をまとめて確認できる非公式ダッシュボード。

説明：

> KOAN Plusは、大阪大学のKOANとCLEを利用する学生向けの非公式拡張機能です。時間割、課題・アンケートの締切、休講・教室変更、連絡・掲示、成績、授業資料をデスクトップの画面で整理して確認できます。
>
> 自動ログインと二段階認証の補助は任意です。学務情報は端末内に保存され、開発者のサーバーへ収集しません。大学への認証・情報取得には通信が必要です。履修登録、課題提出、掲示・メッセージ本文の確認は大学の公式ページで行います。
>
> 大阪大学の利用資格とアカウントが必要です。大学公式のサービスではありません。デスクトップ版Firefox 140以降向けです。

サポートサイト：`https://github.com/haze-355/KOAN-Plus/issues`

## 審査員向け説明（英語）

```text
This is an unofficial, local academic dashboard for Osaka University students.
The runtime requires access to the university's authenticated KOAN and CLE services.
There is no public university test account bundled with this submission.
Please contact the maintainer if additional authenticated review access is needed.
Do not use production credentials from repository files; none are provided.

The matching source archive contains BUILDING.md with the exact build environment
and commands (Node 22.16.0, npm 10.9.2, npm ci, npm run build:firefox).
Compare dist-firefox/ with the extracted extension package. The tests use synthetic
data and can exercise the UI without a university account.

Credentials and academic data are stored locally. Optional authenticationInfo
consent gates automatic authentication to university services; credentials are
not sent to the extension developer. Optional technicalAndInteraction consent
controls User-Agent prefill when the user opens the existing Google contact form.
The extension version is still prefilled. There is no analytics backend.
See PRIVACY.md for the complete data flows and docs/firefox-verification.md for
what has and has not been tested. Android is not supported.
```

## 提出前の未確認項目と公開後の確認

- 最低対応版Firefox 140、実ファイルの個別・一括保存、MFA自動入力・登録には未確認項目があります。実施範囲は [検証記録](./firefox-verification.md) を参照してください。
- ローカルの `web-ext lint` とAMOの検証結果は別です。既知の警告の説明も検証記録にありますが、審査通過を保証するものではありません。
- 掲載画像を使う場合は合成データで作成し、実際の学生情報や認証画面を掲載しません。
- 公開できたら署名済み版を通常のFirefoxへインストールして確認し、READMEなどにAMOの公開URLと確認日を記録します。Chrome版の提出・公開状況は、Firefox版とは別に管理します。
