# KOAN Plus

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[日本語](./README.md) · [Chrome Web Store](https://chromewebstore.google.com/detail/koan-plus/mpppnbfaakngenflnnoclhbckmjdngkm) · [User guide (Japanese)](./docs/user-guide.md) · [Changelog (Japanese)](./CHANGELOG.md)

KOAN Plus is an **unofficial browser extension for viewing Osaka University's KOAN and CLE information together**. Check assignment deadlines, class cancellations, room changes, announcements, and grades in a desktop dashboard.

It leaves the ordinary KOAN and CLE page designs unchanged. The source code is available under the MIT license. This README describes the latest repository implementation; version and publication status are recorded in the [changelog](./CHANGELOG.md).
The repository version is **1.6.0**; the published store version may differ.

Version 1.6.0 includes desktop Firefox 140+ support. It has not been submitted to either store; no signed Firefox distribution is available yet. It is separate from the Chrome 1.5.0 package submitted for review. See the [verification guide](./docs/firefox-verification.md), [publication guide](./docs/firefox-publishing.md) (Japanese), and [source build instructions for reviewers](./BUILDING.md).

## What you can do

The interface uses Japanese labels.

| Screen | What it shows |
| --- | --- |
| Home (ホーム) | Assignment and survey deadlines, upcoming class changes, CLE communications, and KOAN bulletins. Select a date in the calendar to see that day's classes. |
| Courses (授業) | Select a class in the timetable to see its room, instructor, changes, and assignments, communications, or materials in the right column. The timetable stays visible. |
| Bulletins (掲示) | Search by keyword or category and filter by university importance, attention candidates, unread state, or benefits and rewards. |
| Grades (成績) | Earned credits, cumulative GPA, term GPA, course grades, and academic history. Expand a course category to view its records. |
| Settings (設定) | Optional auto-login and two-factor authentication assistance. Expand Data management (データ管理) to export or delete cached academic data. |

Home keeps CLE and KOAN in separate sections so a large bulletin feed does not crowd out course communications. The course detail panel brings related CLE communications and KOAN bulletins together. CLE materials can be downloaded individually or in a batch from the Materials (資料) tab. Light and dark themes are available.

**Important (重要) means the university marked the bulletin as important.** Attention (要確認) and Benefits/rewards (特典・謝礼) are discovery aids. They do not establish personal relevance or eligibility; check the original bulletin for conditions.

## Getting started

1. Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/koan-plus/mpppnbfaakngenflnnoclhbckmjdngkm) and open KOAN Plus using its extension icon.
2. Review the terms and privacy policy in the first-run screen.
3. Set up optional auto-login, or continue with manual login. You can change this later in Settings.
4. Log in to KOAN and CLE in the same browser, then select Refresh (更新) at the top right of KOAN Plus. Complete any authentication prompts on the university's official pages.

Follow the links to the official services to submit assignments, register for courses, and read bulletin or message bodies. KOAN Plus does not replace those official actions.

## Refreshing and troubleshooting

Saved information appears immediately when you reopen the dashboard. With auto-login enabled, expired data refreshes automatically while KOAN Plus is visible and online. Manual Refresh remains available with auto-login disabled.

You can switch screens during retrieval. Not fetched, partially fetched, failed, and verified empty results are shown separately. If an update fails, saved information remains available. Open Sync details (同期の詳細) at the top right to inspect each source and retry.

If data still does not update, check your connection, complete login in the official KOAN/CLE pages, and retry. A visible, online dashboard can resume queued updates after a waiting period. Do not delete the cache as a first troubleshooting step: it contains the information you can still read.

University service changes or network conditions can delay or prevent retrieval. Verify important deadlines, submission status, and grades in the official services. See the [refresh strategy](./docs/sync-policy.en.md) for technical details.

## Data and login information

- Academic data and settings stay in the browser you use. KOAN Plus does not send academic data or credentials to a developer-operated server and has no advertising, analytics, or automatic crash reporting.
- The extension communicates with KOAN, CLE, and the university's authentication services to retrieve data and log in. It does not prefetch bulletin or message bodies.
- Auto-login and two-factor authentication assistance are optional. Saved credentials are encrypted locally, but the key is available in the same environment; this does not protect against compromise of the device or extension runtime.
- Storing two-factor authentication information on the login device can weaken MFA protection. Review the university rules that apply to you and the [terms](./TERMS.md) before enabling it. Use a device you control.
- Contact (お問い合わせ) opens Google Forms and sends the extension version and browser User-Agent to Google as prefilled URL parameters. Filling in and submitting the form is optional.

See the bilingual [privacy policy](./PRIVACY.md) for data categories, permission purposes, storage, and deletion. Cache deletion in Settings → Data management preserves saved login information, MFA settings, theme, and terms acceptance. Credentials and MFA have separate deletion controls.

## Install from source

Use Node.js 20.x starting at 20.19.0, or Node.js 22.12.0 or later, with npm. The extension declares Chrome 102 as its minimum version; other Chromium browsers may behave differently.

```sh
git clone https://github.com/haze-355/KOAN-Plus.git
cd KOAN-Plus
npm ci
npm run build
```

1. Open `chrome://extensions` and enable Developer mode.
2. Select **Load unpacked**, then choose the generated **`dist/`** directory.
3. After rebuilding an update, reload the extension and its dashboard page.

Do not select the project root. Its manifest only shows a development guide when the wrong directory is loaded.

## Development and contributions

Bug reports, feature suggestions, translations, and improvements to code or documentation are welcome. Use [GitHub Issues](https://github.com/haze-355/KOAN-Plus/issues) or Pull Requests. Do not attach university IDs, credentials, personal grades, or message bodies. Report vulnerabilities according to [SECURITY.md](./SECURITY.md), not in public issues.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and required checks, and [DEVELOPMENT.md](./DEVELOPMENT.md) for project goals and design decisions.

```sh
npm run dev                      # UI development server
npm run typecheck                # Type checking
npm test                         # Unit tests
npx playwright install chromium  # Install UI test browser once
npm run test:ui                  # UI tests using synthetic data
npm run build                    # Build the extension
npm run zip                      # Build koan-plus.zip for distribution
```

The development server alone cannot reproduce all extension authentication and tab integration. Verify these using the built extension. Do not commit generated builds, dependencies, test artifacts, or ZIP files.

## License and terms

The code is licensed under [MIT](./LICENSE). Use of the extension is subject to [TERMS.md](./TERMS.md). KOAN Plus is not provided, endorsed, or guaranteed by Osaka University. Changes to KOAN, CLE, or the authentication services may stop features from working.

See [Third-party notices](./THIRD_PARTY_NOTICES.md) for dependency and icon attribution. Builds and distribution ZIPs include the project license and full third-party license texts.
