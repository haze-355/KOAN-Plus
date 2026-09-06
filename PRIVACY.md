# Privacy Policy / プライバシーポリシー

Last updated / 最終更新日: 2026-09-06

## English

### Overview

KOAN Plus is a locally installed browser extension for Chrome and Firefox. It has no
developer-operated backend, analytics, advertising, or automatic crash
reporting. Academic and authentication data is processed on the user's device
and sent only to the Osaka University services needed for the requested
operation, except for the optional Google Forms contact flow described below.

### Data Processed And Stored Locally

KOAN Plus may process and store:

- KOAN schedules, course registrations, class changes, survey titles,
  response states and periods, bulletin metadata, grades, credits, GPA data,
  and update timestamps;
- CLE course mappings, assignment titles, due dates, submission or grading
  status, unread message counts, course announcement titles, bodies and dates,
  course material file names and download
  URLs, and update timestamps;
- display preferences and refresh coordination timestamps;
- when auto-login is enabled, the university ID, password, TOTP secret,
  temporary cancellation code, and MFA consent state.

Course announcements are separate from CLE messages. Their bodies are retrieved
and cached for display; CLE message bodies and KOAN bulletin bodies are not
prefetched.

Dashboard data and preferences are stored in the extension origin's
`localStorage`. Credentials and MFA data are encrypted with AES-GCM-256 and
stored in IndexedDB together with a non-extractable encryption key.
Short-lived tab and refresh coordination state is stored in
the browser's extension session storage (`chrome.storage.session`).

The local encryption prevents casual plaintext inspection. Because the key and
ciphertext are available to the same extension runtime, it does not protect
against compromise of the device, browser profile, or extension runtime.

### Network Communications

The extension has host access to and communicates with these Osaka University
domains:

- `https://koan.osaka-u.ac.jp` for KOAN data;
- `https://www.cle.osaka-u.ac.jp` for CLE data and login;
- `https://ou-idp.auth.osaka-u.ac.jp` for authentication;
- `https://auth-mfa.auth.osaka-u.ac.jp` for MFA setup and authentication.

Requests use the user's existing browser session. The browser manages the session
cookies; KOAN Plus does not request the cookies permission.

When auto-login or MFA is enabled, the university ID, password, TOTP secret,
and generated authentication codes may be sent to the Osaka University
authentication services required for the requested operation. In Firefox,
this transmission is performed only while the optional `authenticationInfo`
data permission is granted. If that permission is denied or revoked, KOAN Plus
does not provide the credentials or codes to authentication pages, while the
encrypted local data is retained.

When auto-login is enabled, a visible, online dashboard automatically refreshes
expired academic data, including grades and bulletin metadata. Cached results
are reused across tabs. Hidden or offline dashboards start no automatic sync.
Manual refresh remains available; disabling auto-login stops periodic sync.

The sidebar's **Contact** link opens a Google Form at `docs.google.com`.
Opening the link always sends the KOAN Plus version to Google as a prefilled
URL parameter. In Firefox, the browser User-Agent is included only when the
optional `technicalAndInteraction` data permission is granted; otherwise the
User-Agent parameter is omitted. Chrome continues to include the User-Agent.
Any information the user enters and submits is processed by Google under
Google's applicable terms and privacy policy. The form is optional and is
never opened automatically.

### Data Not Collected By The Maintainer

KOAN Plus does not automatically send credentials, TOTP secrets, grades,
schedules, bulletin data, CLE data, browsing history, analytics events, or
crash reports to the maintainer. It does not prefetch bulletin bodies or CLE
message bodies for local storage.

### Retention And Deletion

Local dashboard data remains in the extension's storage until it is replaced,
cleared by the user or browser, or the extension is removed. Saved login and
MFA data remains until the corresponding delete action is used, the extension
storage is cleared, or the extension is removed.

Users can delete login credentials and MFA data separately from the extension
settings. Removing the extension or clearing its site data deletes its local
storage. Data submitted to Google Forms is controlled by the form operator and
Google and cannot be deleted through KOAN Plus.

### Permissions

KOAN Plus requests:

- `scripting` to run restricted fetches and page actions in KOAN/CLE tabs;
- `tabs` to find, open, update, and close authentication and CLE tabs;
- `storage` for session-scoped refresh and tab coordination;
- `downloads` to save CLE course materials to the user's download folder;
- `downloads.ui` (Chrome only) to temporarily hide Chrome's download bubble while a batch
  of materials is being saved, so it does not flash once per file;
- Firefox data collection permissions: optional `authenticationInfo` for
  authentication data and optional `technicalAndInteraction` for the browser
  User-Agent included in the contact form;
- host permissions for the four Osaka University domains listed above.

## 日本語

### 概要

KOAN Plus は、ユーザーがローカルにインストールする Chrome / Firefox 対応の
ブラウザ拡張機能です。
開発者が運営するバックエンド、アクセス解析、広告、自動クラッシュレポートは
ありません。学務情報と認証情報はユーザーの端末上で処理され、要求された操作に
必要な大阪大学のサービスにのみ送信されます。ただし、任意で利用する Google Forms
のお問い合わせ機能は例外であり、後述します。

### 端末上で処理・保存するデータ

KOAN Plus は、次のデータを処理・保存する場合があります。

- KOANの時間割、履修科目、休講・教室変更、アンケート名・回答状態・実施期間、
  掲示メタデータ、成績、単位、GPA、更新日時
- CLEの科目対応、課題名、期限、提出・採点状態、未読メッセージ数、授業の連絡事項の件名・本文・日時、
  配布資料のファイル名・取得用URL、更新日時
- 表示設定、更新制御用のタイムスタンプ
- 自動ログインを有効にした場合の学内個人ID、パスワード、TOTPシークレット、
  一時解除コード、MFA同意状態

CLEの授業の連絡事項はメッセージとは別の情報で、表示のために本文も取得・保存します。
CLEメッセージ本文とKOAN掲示本文の事前取得は行いません。

ダッシュボードデータと表示設定は、拡張機能オリジンの `localStorage` に保存されます。
認証情報とMFA情報は AES-GCM（256-bit）で暗号化され、非エクスポート鍵とともに
IndexedDB に保存されます。タブと更新の制御に使う一時情報は、ブラウザ拡張機能の
セッションストレージ（`chrome.storage.session`）に保存されます。

この暗号化は、平文を偶発的に閲覧されることを防ぐためのものです。暗号鍵と暗号文は
同じ拡張機能実行環境から利用できるため、端末、ブラウザプロファイル、拡張機能実行環境
が侵害された場合の保護にはなりません。

### ネットワーク通信

本拡張機能は、次の大阪大学ドメインへのホスト権限を持ち、通信します。

- `https://koan.osaka-u.ac.jp`: KOANデータ
- `https://www.cle.osaka-u.ac.jp`: CLEデータとログイン
- `https://ou-idp.auth.osaka-u.ac.jp`: 認証
- `https://auth-mfa.auth.osaka-u.ac.jp`: MFA登録と認証

通信にはブラウザの既存セッションを利用します。セッションクッキーはブラウザが管理し、
KOAN Plus は Cookie API の権限を要求しません。

自動ログインまたはMFAを有効にした場合、大学個人ID、パスワード、TOTPシークレット、
生成した認証コードは、要求された操作に必要な大阪大学の認証サービスへ送信される場合が
あります。Firefoxでは、optionalな `authenticationInfo` データ権限が許可されている間だけ
この送信を行います。許可が拒否または取り消された場合、KOAN Plusは認証ページへ認証情報や
コードを渡しません。暗号化済みのローカルデータは保持されます。

自動ログインが有効な場合、表示中かつオンラインのダッシュボードは、成績と掲示
メタデータを含む保存期限切れの学務情報を自動同期します。取得結果はタブ間で
再利用します。非表示・オフライン中は新しい自動同期を開始しません。手動更新も
利用でき、自動ログインを停止すると定期的な自動同期も停止します。

サイドバーの「お問い合わせ」は `docs.google.com` の Google Forms を開きます。
リンクを開くと、KOAN Plusのバージョンが常にフォームの事前入力用URLパラメータとして
Googleに送信されます。Firefoxでは、optionalな `technicalAndInteraction` データ権限が
許可されている場合だけブラウザのUser-Agentを付加します。未許可または確認できない場合、
User-Agentパラメータは付加しません。Chromeでは従来どおりUser-Agentを付加します。ユーザーが
フォームに入力して送信した情報も、Googleの適用される規約とプライバシーポリシーに基づいて
処理されます。
フォームは任意であり、自動的に開かれることはありません。

### メンテナーが自動収集しないデータ

KOAN Plus は、認証情報、TOTPシークレット、成績、時間割、掲示データ、CLEデータ、
閲覧履歴、アクセス解析イベント、クラッシュレポートをメンテナーへ自動送信しません。
また、掲示本文やCLEメッセージ本文をローカル保存するための事前取得は行いません。

### 保存期間と削除

ローカルのダッシュボードデータは、新しいデータで置き換えられるか、ユーザーまたは
ブラウザによって消去されるか、拡張機能が削除されるまで保存されます。ログイン情報と
MFA情報は、対応する削除操作、拡張機能データの消去、または拡張機能の削除まで保存されます。

ログイン情報とMFA情報は、拡張機能の設定から個別に削除できます。拡張機能の削除または
サイトデータの消去によって、ローカル保存データを削除できます。Google Forms に送信した
データはフォーム運営者と Google が管理し、KOAN Plus からは削除できません。

### 権限

KOAN Plus は次の権限を要求します。

- `scripting`: KOAN/CLEタブ内で、制限された取得処理とページ操作を行うため
- `tabs`: 認証タブやCLEタブを検索、作成、更新、終了するため
- `storage`: セッション単位の更新・タブ制御を保存するため
- `downloads`: CLEの配布資料をユーザーのダウンロードフォルダへ保存するため
- `downloads.ui`（Chromeのみ）: 一括保存中に Chrome のダウンロード表示を一時的に非表示にし、
  ファイルごとの点滅を防ぐため
- Firefoxのデータ収集権限: 認証情報用のoptionalな `authenticationInfo` と、
  お問い合わせフォームへUser-Agentを付加するためのoptionalな `technicalAndInteraction`
- 上記4つの大阪大学ドメインに対するホスト権限
