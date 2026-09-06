import { expect, test, type Page } from "@playwright/test";
import {
  CLE_CACHE_KEY,
  CLE_MATERIALS_CACHE_KEY,
  GRADES_CACHE_KEY,
  KOAN_CACHE_KEY,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from "../src/storage";

const ONBOARDING_KEY = "koan-plus-onboarding-v1";
const THEME_KEY = "koan-plus-theme";
function onboardingRecord() {
  return {
    completed: true,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    acceptedAt: new Date().toISOString(),
  };
}

function fixture({ loaded = true } = {}) {
  const updatedAt = loaded ? new Date().toISOString() : null;
  return {
    onboarding: onboardingRecord(),
    koan: {
      schedule: [],
      courses: [],
      changes: [],
      surveys: [],
      notices: [],
      lightUpdatedAt: updatedAt,
      snapshotUpdatedAt: updatedAt,
      scheduleUpdatedAt: updatedAt,
      futureScheduleUpdatedAt: updatedAt,
      coursesUpdatedAt: updatedAt,
      changesUpdatedAt: updatedAt,
      futureChangesUpdatedAt: updatedAt,
      surveysUpdatedAt: updatedAt,
      noticesUpdatedAt: updatedAt,
      snapshotVersion: 2,
      snapshotComplete: true,
      warnings: [],
    },
    cle: {
      courses: [],
      tasks: [],
      messages: [],
      unreadMessages: 0,
      updatedAt,
      coursesUpdatedAt: updatedAt,
      tasksUpdatedAt: updatedAt,
      messagesUpdatedAt: updatedAt,
      taskStatusesUpdatedAt: updatedAt,
      taskScopeVersion: 3,
      taskStatusCursor: 0,
      warnings: [],
    },
  };
}

async function seed(page: Page, value: ReturnType<typeof fixture>) {
  await page.addInitScript(({ keys, value: initialValue }) => {
    localStorage.setItem(keys.onboarding, JSON.stringify(initialValue.onboarding));
    localStorage.setItem(keys.koan, JSON.stringify(initialValue.koan));
    localStorage.setItem(keys.cle, JSON.stringify(initialValue.cle));
    localStorage.setItem(keys.theme, "light");
  }, {
    keys: {
      onboarding: ONBOARDING_KEY,
      koan: KOAN_CACHE_KEY,
      cle: CLE_CACHE_KEY,
      theme: THEME_KEY,
    },
    value,
  });
}

async function seedOnce(page: Page, value: ReturnType<typeof fixture>) {
  await page.addInitScript(({ keys, value: initialValue }) => {
    const marker = "koan-plus-ui-fixture-seeded";
    if (sessionStorage.getItem(marker)) return;
    sessionStorage.setItem(marker, "1");
    localStorage.setItem(keys.onboarding, JSON.stringify(initialValue.onboarding));
    localStorage.setItem(keys.koan, JSON.stringify(initialValue.koan));
    localStorage.setItem(keys.cle, JSON.stringify(initialValue.cle));
    localStorage.setItem(keys.theme, "light");
  }, {
    keys: {
      onboarding: ONBOARDING_KEY,
      koan: KOAN_CACHE_KEY,
      cle: CLE_CACHE_KEY,
      theme: THEME_KEY,
    },
    value,
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
}

test("390px navigation stays compact and skip link reaches the main content", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, fixture());
  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "画面切替" });
  await expect(navigation).toBeVisible();
  await expect(page.getByRole("button", { name: "設定", exact: true })).toBeVisible();

  const skipLink = page.getByRole("link", { name: "本文へ移動" });
  await skipLink.focus();
  await skipLink.click();
  await expect(page.locator("#main-content")).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("1024px settings collapses to one column without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await seed(page, fixture());
  await page.goto("/");
  await page.getByRole("button", { name: "設定", exact: true }).click();

  await expect(page.getByRole("heading", { name: "設定", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "データ管理", exact: true })).toBeVisible();
  const columnCount = await page.locator(".settings-container").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
  );
  expect(columnCount).toBe(1);
  await expectNoHorizontalOverflow(page);
});

test("sync details close on view change and focus leaving the popover", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await seed(page, fixture());
  await page.goto("/");

  const details = page.locator(".sync-details");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "授業", exact: true }).click();
  await expect(details).not.toHaveAttribute("open", "");

  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "設定", exact: true }).focus();
  await expect(details).not.toHaveAttribute("open", "");
});

test("cache deletion requires confirmation and preserves onboarding", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await seedOnce(page, fixture());
  await page.goto("/");
  await page.getByRole("button", { name: "設定", exact: true }).click();

  await page.locator(".storage-management-summary").click();
  await page.getByRole("button", { name: "キャッシュを削除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "キャッシュを削除して再読み込みしますか", exact: true })).toBeVisible();
  await expect(page.getByText(/認証情報・二段階認証情報・テーマ・利用規約への同意は削除されません/)).toBeVisible();
  await expect(page.getByRole("button", { name: "削除して再読み込み", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByRole("heading", { name: "データ管理", exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), KOAN_CACHE_KEY)).not.toBeNull();

  await page.getByRole("button", { name: "キャッシュを削除", exact: true }).click();
  await page.getByRole("button", { name: "削除して再読み込み", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), KOAN_CACHE_KEY)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), CLE_CACHE_KEY)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), ONBOARDING_KEY)).not.toBeNull();
});

test("fresh, idle and partial refresh states remain distinguishable", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await seed(page, fixture({ loaded: false }));
  await page.goto("/");

  const details = page.locator(".sync-details");
  await expect(details.locator("summary")).toContainText("同期の詳細");
  await expect(page.locator("main .page-source-status, main .source-status-strip")).toHaveCount(0);
  await expect(page.locator(".collection-feedback").filter({ hasText: "はまだ取得していません" }).first()).toBeVisible();
  await details.locator("summary").click();
  await expect(details.locator(".sync-popover")).toBeVisible();
  await expect(details.locator(".source-status")).toHaveCount(4);
  await expect(details.locator(".source-status-name")).toHaveText(["KOAN", "CLE", "掲示", "成績"]);
  await expect(page.locator("main [role=alert]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(details).not.toHaveAttribute("open", "");

  await page.reload();
  await seed(page, fixture());
  await page.reload();
  await page.locator(".sync-details summary").click();
  await expect(page.locator(".sync-details .source-status-fresh")).toHaveCount(3);
  await expect(page.locator(".sync-details .source-status-idle")).toHaveCount(1);
  await expect(page.getByText("最終成功", { exact: false }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.addInitScript(({ koanKey, gradesKey }) => {
    const koan = JSON.parse(localStorage.getItem(koanKey)!);
    koan.changesUpdatedAt = koan.noticesUpdatedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    localStorage.setItem(koanKey, JSON.stringify(koan));
    localStorage.setItem(gradesKey, JSON.stringify({ creditsTotal: 0, cumulativeGpa: "", termGpas: [], groups: [], courses: [], history: [], updatedAt: new Date().toISOString() }));
    const chromeMock = {
      runtime: {
        sendMessage: async (message: { type?: string }) => {
          if (message.type === "auth-settings") {
            return { ok: true, configured: true, enabled: true, autoSubmit: true, mfaEnabled: true, idHint: "fixture" };
          }
          if (message.type === "auth-get-secrets") return { ok: true, configured: false };
          if (message.type === "auth-claim-startup-refresh") return { ok: true, shouldRefresh: false };
          if (message.type === "auth-claim-dashboard-refresh") return { ok: true, allowed: true };
          if (message.type === "auth-ensure-koan") {
            return {
              ok: true,
              tabId: 1,
              portalHtml: "<html><body><div id='portal-body'></div></body></html>",
              portalUrl: "https://koan.osaka-u.ac.jp/campusweb/campusportal.do?page=main",
            };
          }
          if (message.type === "auth-ensure-cle") return { ok: true, tabId: 2 };
          if (message.type === "cle-fetch") {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
            return { ok: false, error: "fixture partial failure" };
          }
          return { ok: true };
        },
      },
    };
    Object.defineProperty(window, "chrome", { configurable: true, value: chromeMock });
  }, { koanKey: KOAN_CACHE_KEY, gradesKey: GRADES_CACHE_KEY });
  await page.route("https://koan.osaka-u.ac.jp/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      body: "<html><body></body></html>",
      headers: { "access-control-allow-origin": "*", "content-type": "text/html" },
      status: 200,
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(page.getByRole("button", { name: "更新中…", exact: true })).toBeVisible();
  const syncDetails = page.locator(".sync-details");
  await expect(syncDetails.locator("summary")).toContainText("同期の詳細", { timeout: 10_000 });
  await syncDetails.locator("summary").click();
  await expect(syncDetails.locator(".source-status-partial").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("main .page-source-status, main .source-status-strip")).toHaveCount(0);
  await expect(page.locator("main [role=alert]")).toHaveCount(0);
  await expect(page.locator("header .source-status")).toHaveCount(4);
});

test("grades tables expose captions and column scopes", async ({ page }) => {
  await seed(page, fixture());
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, {
    key: GRADES_CACHE_KEY,
    value: {
      creditsTotal: 2,
      cumulativeGpa: "3.50",
      termGpas: [{ year: "2026", term: "前期", gpa: "3.50" }],
      groups: [{
        name: "専門",
        credits: 2,
        courses: [{
          majorCategory: "専門",
          minorCategory: "必修",
          course: "脳科学",
          credits: 2,
          year: "2026",
          term: "前期",
          grade: "A",
          pass: "合格",
        }],
      }],
      courses: [],
      history: [{
        code: "A-1",
        course: "脳科学",
        teacher: "教員",
        year: "2026",
        grade: "A",
        pass: "合格",
      }],
      updatedAt: new Date().toISOString(),
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "成績", exact: true }).click();

  await expect(page.locator("table.record-table caption.sr-only")).toHaveCount(3);
  const headersHaveColumnScope = await page.locator("table.record-table th").evaluateAll((headers) =>
    headers.length > 0 && headers.every((header) => header.getAttribute("scope") === "col"),
  );
  expect(headersHaveColumnScope).toBe(true);
  const group = page.locator(".credit-groups details").first();
  await group.locator("summary").press("Enter");
  await expect(group.getByRole("cell", { name: "脳科学", exact: true })).toBeVisible();
  await expect(group.locator(".grade-common-category")).toHaveText("詳細区分：専門");
  await expect(group.getByRole("columnheader", { name: "詳細区分", exact: true })).toHaveCount(0);
  await expect(group.getByRole("columnheader")).toHaveCount(4);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const motion = await group.locator(".grade-group-content").evaluate(el => getComputedStyle(el).animationDuration);
  expect(parseFloat(motion)).toBeLessThan(0.001);
  await group.locator("summary").press("Enter");
  await expect(group.getByRole("cell", { name: "脳科学", exact: true })).not.toBeVisible();
});

test("material download controls name the item and batch count", async ({ page }) => {
  const value = fixture();
  Object.assign(value.koan, {
    courses: [{
      code: "C-1",
      departmentCode: "",
      year: "2026",
      title: "資料授業",
      day: "月",
      period: "1",
      teacherAndRoom: "教員 / A101",
      syllabusUrl: "",
    }],
  });
  Object.assign(value.cle, {
    courses: [{
      courseId: "cle-1",
      displayId: "",
      timetableCode: "C-1",
      name: "資料授業",
      available: true,
    }],
  });
  await seed(page, value);
  await page.addInitScript(({ key, courseId, updatedAt }) => {
    localStorage.setItem(key, JSON.stringify({
      [courseId]: {
        courseId,
        materials: [
          {
            id: "material-1",
            contentId: "content-1",
            attachmentId: "attachment-1",
            title: "講義資料",
            fileName: "lecture.pdf",
            mimeType: "application/pdf",
            size: 1024,
            addedAt: updatedAt,
            folderPath: [],
            downloadUrl: "https://www.cle.osaka-u.ac.jp/materials/lecture.pdf",
          },
          {
            id: "material-2",
            contentId: "content-2",
            attachmentId: "attachment-2",
            title: "演習資料",
            fileName: "exercise.pdf",
            mimeType: "application/pdf",
            size: 2048,
            addedAt: updatedAt,
            folderPath: [],
            downloadUrl: "https://www.cle.osaka-u.ac.jp/materials/exercise.pdf",
          },
        ],
        updatedAt,
        complete: true,
        warnings: [],
      },
    }));
  }, {
    key: CLE_MATERIALS_CACHE_KEY,
    courseId: "cle-1",
    updatedAt: new Date().toISOString(),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "授業", exact: true }).click();
  await page.getByRole("button", { name: /資料授業/ }).first().click();
  await page.getByRole("tab", { name: "資料", exact: true }).click();

  await expect(page.getByRole("button", { name: "講義資料をダウンロード", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "演習資料をダウンロード", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "2件の資料をすべてダウンロード", exact: true })).toBeVisible();
});

test("unfetched resources do not claim there are no deadlines even when other data is cached", async ({ page }) => {
  const value = fixture();
  value.koan.scheduleUpdatedAt = null;
  value.koan.surveysUpdatedAt = null;
  value.cle.tasksUpdatedAt = null;
  await seed(page, value);
  await page.goto("/");
  await expect(page.locator(".next-actions .collection-feedback")).toContainText("はまだ取得していません");
  await expect(page.locator(".selected-deadline-panel")).toHaveCount(0);
  await expect(page.getByText("この日の締切はありません", { exact: true })).toHaveCount(0);
  await expect(page.getByText("対応が必要な課題・締切はありません", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "時間割を取得", exact: true })).toBeVisible();
});

test("notice filters prioritize importance and keep search controls concise", async ({ page }) => {
  const value = fixture();
  Object.assign(value.koan, { notices: [
    { title: "試験の日程変更について", priority: "", href: "https://koan.osaka-u.ac.jp/fixture1", genre: "教務", unread: true, department: "全学", author: "教務係", period: "2026/09/05", live: true },
    { title: "登録内容のお知らせ", priority: "○", href: "https://koan.osaka-u.ac.jp/fixture2", genre: "教務", unread: false, department: "全学", author: "教務係", period: "2026/09/05", live: true },
  ] });
  await seed(page, value);
  await page.goto("/");
  await page.getByRole("button", { name: "掲示", exact: true }).click();
  await page.getByRole("button", { name: /重要 1/ }).click();
  await expect(page.locator(".notice-row")).toHaveCount(1);
  await expect(page.locator(".notice-scope-tabs button").first()).toContainText("重要");
  await expect(page.locator(".notice-results-summary, .notice-filter-help")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "条件をクリア", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "試験の日程変更について", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /要確認/ }).first().click();
  await expect(page.getByText("候補の理由：未読・件名に「試験」を含む", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "掲示を検索" }).fill("一致しない語句");
  await expect(page.locator(".notice-row")).toHaveCount(0);
  await page.getByRole("textbox", { name: "掲示を検索" }).fill("");
  await page.getByRole("button", { name: /すべて 2/ }).click();
  await expect(page.getByRole("textbox", { name: "掲示を検索" })).toHaveValue("");
  await expect(page.locator(".notice-row")).toHaveCount(2);
});

function courseOverviewFixture() {
  const value = fixture();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  Object.assign(value.koan, {
    courses: ["基礎神経科学", "統計学"].map((title, i) => ({ code: `C-${i}`, departmentCode: "", year: "2026", title, day: "月", period: String(i + 1), teacherAndRoom: "教員 / A101", syllabusUrl: "https://koan.osaka-u.ac.jp/" })),
    changes: [{ type: "休講", date: today, period: "1", course: "基礎神経科学" }, { type: "補講", date: "2025/01/01", period: "2", course: "基礎神経科学" }],
    notices: [{ title: "基礎神経科学 KOAN掲示", href: "https://koan.osaka-u.ac.jp/notice?keijino=1", genre: "授業", priority: "", unread: true, department: "", author: "", period: today, live: true }],
  });
  Object.assign(value.cle, {
    courses: value.koan.courses.map((course: { code: string; title: string }, i: number) => ({ courseId: `cle-${i}`, timetableCode: course.code, displayId: "", name: course.title, available: true })),
    tasks: [{ id: "done", courseId: "cle-0", courseName: "基礎神経科学", title: "完了したレポート", dueAt: null, status: "提出済み" }, { id: "active", courseId: "cle-0", courseName: "基礎神経科学", title: "取り組むレポート", dueAt: `${today}T23:59:59+09:00`, status: "未着手" }],
    announcements: [{ id: "ann", courseId: "cle-0", courseName: "基礎神経科学", title: "CLEからの授業連絡", body: "<p>連絡の本文です。</p>", created: new Date().toISOString() }],
    announcementsUpdatedAt: new Date().toISOString(), announcementsPendingCount: 0,
    messages: [{ courseId: "cle-0", courseName: "基礎神経科学", unreadCount: 2 }], unreadMessages: 2,
  });
  return value;
}

test("course tabs keep timetable and changes visible, merge communications, and support keyboard selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await seed(page, courseOverviewFixture());
  await page.goto("/");
  await page.getByRole("button", { name: "授業", exact: true }).click();
  await page.getByRole("button", { name: /基礎神経科学/ }).first().click();
  const detail = page.locator(".course-detail");
  const widths = await detail.getByRole("tab").evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  await expect(detail.getByRole("tab", { name: /課題 今日 1/ })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByRole("link", { name: /取り組むレポート/ })).toBeVisible();
  await expect(detail.getByRole("link", { name: /完了したレポート/ })).not.toBeVisible();
  await detail.getByText("提出済み・採点済み 1件", { exact: true }).click();
  await expect(detail.getByRole("link", { name: /完了したレポート/ })).toBeVisible();
  await detail.getByRole("tab", { name: /課題/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(detail.getByRole("tab", { name: /連絡・掲示 未読 3/ })).toBeFocused();
  await expect(detail.getByText("基礎神経科学 KOAN掲示", { exact: true })).toBeVisible();
  await expect(detail.getByText("CLEからの授業連絡", { exact: true })).toBeVisible();
  await expect(detail.locator(".course-current-changes")).toContainText("休講");
  await expect(detail.locator(".course-current-changes")).not.toContainText("補講");
  await expect(detail.getByRole("link", { name: /^CLEを開く/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /統計学/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /統計学/ }).first().click();
  await expect(detail.getByRole("heading", { name: "統計学", exact: true })).toBeVisible();
  await expect(detail.getByRole("tab", { name: "課題", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByText("取り組むレポート", { exact: true })).toHaveCount(0);
});

test("home shows source sections at the same heading level as next actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await seed(page, courseOverviewFixture());
  await page.goto("/");
  const main = page.locator(".dashboard-main");
  const headings = await main.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings).toEqual(["課題・締切", "直近の休講・変更", "CLEの連絡", "KOANのお知らせ"]);
  await expect(page.locator(".selected-deadline-panel")).toHaveCount(0);
  await expect(page.locator(".upcoming-changes")).toContainText("休講");
  await expect(page.locator(".upcoming-changes")).not.toContainText("補講");
  const cle = page.getByRole("region", { name: "CLEの連絡", exact: true });
  const koan = page.getByRole("region", { name: "KOANのお知らせ", exact: true });
  await expect(cle.getByText("CLEからの授業連絡", { exact: true })).toBeVisible();
  await expect(koan.getByRole("button", { name: "重要", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(koan.getByText("取得済みの情報に重要なお知らせはありません", { exact: true })).toBeVisible();
  await koan.getByRole("button", { name: "最新", exact: true }).click();
  await expect(koan.getByText("基礎神経科学 KOAN掲示", { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: /CLEカレンダー/ })).toHaveCount(0);
  for (const [section, link] of [[cle, cle.getByRole("link", { name: /^CLEを開く/ })], [koan, koan.getByRole("button", { name: "掲示を検索", exact: true })]] as const) {
    const heading = (await section.getByRole("heading").boundingBox())!;
    const action = (await link.boundingBox())!;
    expect(action.x).toBeGreaterThan(heading.x + heading.width);
    expect(Math.abs(action.y + action.height / 2 - heading.y - heading.height / 2)).toBeLessThan(2);
  }
  await expect(cle.getByText("基礎神経科学 KOAN掲示", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "連絡・掲示", exact: true })).toHaveCount(0);
  await expect(main.locator(".communication-source")).toHaveCount(0);
  await expect(koan.getByRole("button", { name: "最新", exact: true })).toHaveAttribute("aria-pressed", "true");
  await koan.getByRole("button", { name: "重要", exact: true }).click();
  await expect(koan.getByText("取得済みの情報に重要なお知らせはありません", { exact: true })).toBeVisible();
  await expect(cle.getByText("CLEからの授業連絡", { exact: true })).toBeVisible();
  await page.locator(".upcoming-changes").getByRole("button").click();
  await expect(page.locator(".course-detail").getByRole("heading", { name: "基礎神経科学", exact: true })).toBeVisible();
});

test("desktop scrolling keeps the header and navigation in place and each column reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  const value = courseOverviewFixture();
  Object.assign(value.koan, { notices: Array.from({ length: 24 }, (_, i) => ({
    title: `確認用の長い掲示 ${i + 1}：履修登録と授業に関するお知らせ`,
    href: `https://koan.osaka-u.ac.jp/notice?keijino=${i + 1}`,
    genre: "教務", priority: "○", unread: true, department: "全学", author: "教務係",
    period: "2026/09/05から2026/09/30まで", live: true,
  })) });
  await seed(page, value);
  await page.goto("/");
  const header = page.locator(".app-topbar");
  const main = page.locator(".dashboard-main");
  const rail = page.locator(".dashboard-right-rail");
  const headerY = (await header.boundingBox())!.y;
  const expectFixedShell = async () => {
    expect((await header.boundingBox())!.y).toBe(headerY);
    expect(await page.locator(".app-shell").evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(600);
    await expect(page.getByRole("button", { name: "ホーム", exact: true })).toBeInViewport();
  };

  // Keyboard navigation to the final action reveals the list footer without moving the shell.
  await main.getByRole("button", { name: /さらに表示/ }).click();
  await main.getByRole("button", { name: /さらに表示/ }).click();
  const footerLink = main.getByRole("button", { name: /KOANのお知らせをさらに表示/ });
  await main.locator(".communication-row").last().focus();
  await page.keyboard.press("Tab");
  await expect(footerLink).toBeFocused();
  await expect(footerLink).toBeInViewport();
  expect(await main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await rail.evaluate((element) => element.scrollTop)).toBe(0);
  await expectFixedShell();

  await main.hover();
  await page.mouse.wheel(0, 4000);
  await expectFixedShell();
  await rail.hover();
  await page.mouse.wheel(0, 4000);
  await expect.poll(() => rail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectFixedShell();

  await page.getByRole("button", { name: "設定", exact: true }).click();
  const settingsFooter = page.getByRole("button", { name: "キャッシュを削除", exact: true });
  await page.locator(".storage-management-summary").press("Enter");
  await settingsFooter.focus();
  await expect(settingsFooter).toBeInViewport();
  await expectFixedShell();
});

test("course messages survive a large university feed and official importance has a dedicated leading label", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const value = courseOverviewFixture();
  const general = Array.from({ length: 400 }, (_, i) => ({
    title: `大学からの合成お知らせ ${i + 1}`, href: `https://koan.osaka-u.ac.jp/notice?keijino=${i + 2}`,
    genre: "学生生活", priority: i === 399 ? "○" : "", unread: true, department: "全学", author: "教務係",
    period: "2025/01/01", live: true,
  }));
  Object.assign(value.koan, { notices: [
    { ...general[0], href: "https://koan.osaka-u.ac.jp/notice?keijino=new", title: "【重要】件名だけの新しい案内", unread: false, period: "2026/09/08" },
    ...general,
    { ...general[0], href: "https://koan.osaka-u.ac.jp/notice?keijino=course", title: "基礎神経科学の重要な授業連絡", priority: "○", period: "2026/09/05" },
  ] });
  await seed(page, value);
  await page.goto("/");
  const courses = page.getByRole("region", { name: "CLEの連絡", exact: true });
  const university = page.getByRole("region", { name: "KOANのお知らせ", exact: true });
  await expect(courses.locator(".communication-row")).toHaveCount(2);
  await expect(courses.locator(".communication-row").first()).toContainText("基礎神経科学");
  await expect(courses.getByText("CLEからの授業連絡", { exact: true })).toBeVisible();
  await expect(university.getByRole("button", { name: "重要", exact: true })).toHaveAttribute("aria-pressed", "true");
  await university.getByRole("button", { name: "最新", exact: true }).click();
  await expect(university.locator(".communication-row")).toHaveCount(3);
  await expect(university.locator(".communication-row").first()).toContainText("【重要】件名だけの新しい案内");
  await expect(university.locator(".communication-row").first()).not.toHaveClass(/communication-important/);

  const importantCourse = university.locator(".communication-important");
  await expect(importantCourse.locator(".communication-attention")).toHaveText("重要（大学の指定）");
  await expect(importantCourse.locator(".communication-content .communication-source")).toHaveCount(0);
  await expect(importantCourse.locator(".communication-state")).toHaveText("未読");
  await university.getByRole("button", { name: "重要", exact: true }).click();
  await expect(university.locator(".communication-row")).toHaveCount(2);
  await expect(university.locator(".communication-row").last()).toContainText("合成お知らせ 400");
  // Filtering university notices must not hide or reorder course messages.
  await expect(courses.locator(".communication-row").first()).toContainText("基礎神経科学");
  await university.getByRole("button", { name: "最新", exact: true }).click();
  await university.getByRole("button", { name: /KOANのお知らせをさらに表示/ }).click();
  await expect(university.locator(".communication-row")).toHaveCount(9);
  await expect(university.getByRole("button", { name: /残り 393件/ })).toBeVisible();
});

test("benefits filter distinguishes explicit rewards from research requiring confirmation", async ({ page }) => {
  const value = fixture();
  Object.assign(value.koan, { notices: [
    "学生向け無料講座の案内", "謝礼あり：実験参加者募集", "認知研究参加者募集", "旅費・謝金を受けるみなさまへ", "地域ボランティア募集", "無料をうたう詐欺への注意喚起",
  ].map((title, i) => ({ title, priority: "", href: `https://koan.osaka-u.ac.jp/fixture-benefit-${i}`, genre: "その他", unread: false, department: "全学", author: "担当係", period: "2026/09/05", live: true })) });
  await seed(page, value);
  await page.goto("/");
  await page.getByRole("button", { name: "掲示", exact: true }).click();
  await page.getByRole("button", { name: /特典・謝礼 3/ }).click();
  await expect(page.locator(".notice-row")).toHaveCount(3);
  await expect(page.locator(".notice-benefit-reason")).toHaveText(["無料・無償", "謝礼あり", "研究参加・謝礼未確認"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});


test("settings keeps actions together and reveals supporting information on demand", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await seed(page, fixture());
  await page.addInitScript(() => Object.defineProperty(window, "chrome", { configurable: true, value: { runtime: { sendMessage: async (message: { type: string }) => {
    if (message.type === "auth-settings") return { ok: true, configured: true, enabled: false, mfaEnabled: true, autoSubmit: true, idHint: "fixture" };
    if (message.type === "auth-get-secrets") return { ok: true, configured: true, totpSecret: "JBSWY3DPEHPK3PXP", temporaryCancelCode: "" };
    return { ok: true };
  } } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const main = page.locator(".settings-main");
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["自動ログイン", "二段階認証", "データ管理"]);
  await expect(page.getByRole("heading", { name: "現在の状態", exact: true })).toHaveCount(0);
  await expect(main.locator(".setting-state")).toHaveText(["無効", "ログイン情報：保存済み", "有効・登録済み"]);
  await expect(main.getByRole("button", { name: "キャッシュを削除", exact: true })).not.toBeVisible();
  await main.locator(".storage-management-summary").press("Enter");
  await expect(main.getByRole("button", { name: "キャッシュを削除", exact: true })).toBeInViewport();
  await main.locator(".storage-management-summary").press("Enter");
  await expect(main.getByRole("button", { name: "キャッシュを削除", exact: true })).not.toBeVisible();
  await main.getByRole("button", { name: "ログイン情報を変更", exact: true }).click();
  await expect(main.getByLabel("大阪大学個人ID", { exact: true })).toBeVisible();
  await main.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(main.getByLabel("大阪大学個人ID", { exact: true })).toHaveCount(0);
  const help = page.locator(".credential-details");
  await expect(help.locator(".credential-safety-body")).not.toBeVisible();
  await help.locator("summary").press("Enter");
  await expect(help.getByText("使用範囲", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});


test("academic links and known notices navigate without waiting for auth probes", async ({ page, context }) => {
  const value = courseOverviewFixture();
  value.koan.notices[0].priority = "○";
  await seed(page, value);
  await page.addInitScript(() => {
    (window as any).navigationChecks = [];
    Object.defineProperty(window, "chrome", { configurable: true, value: { runtime: { sendMessage: (message: { type: string }) => {
      if (message.type === "auth-settings") return Promise.resolve({ ok: true, configured: false, enabled: false });
      (window as any).navigationChecks.push(message.type);
      return new Promise(() => {}); // A stalled probe must not hold navigation hostage.
    } } } });
    localStorage.setItem("koan-plus-snapshot-lease-v1", JSON.stringify({ owner: "fixture-crawl", expiresAt: Date.now() + 60_000 }));
  });
  await context.route("https://www.cle.osaka-u.ac.jp/**", route => route.fulfill({ body: "Synthetic CLE destination" }));
  await context.route("https://koan.osaka-u.ac.jp/**", route => route.fulfill({ body: "Synthetic KOAN destination" }));
  await page.goto("/");
  const open = async (action: () => Promise<void>, expected: string) => {
    const nextPage = context.waitForEvent("page");
    await action();
    const popup = await nextPage;
    await expect(popup).toHaveURL(expected);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
  };
  await open(() => page.getByRole("region", { name: "CLEの連絡", exact: true }).getByRole("link", { name: /^CLEを開く/ }).click(), "https://www.cle.osaka-u.ac.jp/ultra/messages");
  await open(() => page.getByRole("region", { name: "KOANのお知らせ", exact: true }).getByRole("button", { name: /基礎神経科学 KOAN掲示/ }).click(), value.koan.notices[0].href);
  await page.getByRole("button", { name: "掲示", exact: true }).click();
  await open(() => page.locator(".notice-row").first().click(), value.koan.notices[0].href);
  expect(await page.evaluate(() => (window as any).navigationChecks)).toEqual([]);
});

test("empty states distinguish verified zero, unfetched grades and unavailable selection", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const value = fixture();
  Object.assign(value.cle, { announcementsUpdatedAt: new Date().toISOString(), announcements: [], messagesComplete: true });
  await seed(page, value);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "対応が必要な課題・締切はありません" })).toBeVisible();
  await expect(page.locator(".next-actions .empty-state-icon")).toHaveCSS("border-top-width", "0px");
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("01-home-empty.png") });
  await page.getByRole("button", { name: "授業", exact: true }).click();
  await expect(page.getByRole("heading", { name: "授業情報がありません" })).toBeVisible();
  await expect(page.getByText("授業を選択して詳細を表示")).toHaveCount(0);
  await page.getByRole("button", { name: "掲示", exact: true }).click();
  await expect(page.getByRole("heading", { name: "掲示はありません", exact: true })).toBeVisible();
  await expect(page.getByText("検索キーワードや絞り込み条件を変更してください。")).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("02-notices-empty.png") });
  await page.getByRole("button", { name: "成績", exact: true }).click();
  await expect(page.getByRole("heading", { name: "成績はまだ取得していません" })).toBeVisible();
  await expect(page.getByText("右上の更新ボタンからKOANの履修成績を読み込めます。")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("03-grades-unfetched.png") });
});

test("unconfirmed course empty states retain their recovery guidance in both themes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const value = fixture();
  Object.assign(value.koan, { courses: [{code: "C-1", departmentCode: "", year: "2026", title: "確認用の授業", day: "月", period: "1", teacherAndRoom: "教員 / A101", syllabusUrl: ""}] });
  await seed(page, value);
  await page.goto("/");
  await page.getByRole("button", { name: "授業", exact: true }).click();
  await page.getByRole("button", { name: "確認用の授業", exact: true }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: "課題の取得状況は未確認です" })).toBeVisible();
  await expect(panel.getByText("ヘッダーの同期の詳細を確認してください。")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("04-course-unconfirmed.png") });
  await page.getByRole("tab", { name: "連絡・掲示", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "連絡・掲示の取得状況は未確認です" })).toBeVisible();
  await expect(panel.getByText("ヘッダーの同期の詳細を確認してください。")).toBeVisible();
  await page.getByRole("button", { name: "ダークモードに切り替え" }).click();
  await expect(panel.getByText("ヘッダーの同期の詳細を確認してください。")).toBeVisible();
  await expect(page.getByRole("tab", { name: "連絡・掲示", exact: true })).toHaveCSS("color", "rgb(226, 226, 236)");
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("05-course-dark.png") });
});

test("a filtered zero explains filters rather than claiming no notices exist", async ({ page }) => {
  const value = fixture();
  Object.assign(value.koan, { notices: [{title: "合成の掲示", priority: "", href: "https://koan.osaka-u.ac.jp/fixture", genre: "教務", unread: false, department: "全学", author: "教務係", period: "2026/09/05", live: true}] });
  await seed(page, value);
  await page.goto("/");
  await page.getByRole("button", { name: "掲示", exact: true }).click();
  await page.getByRole("textbox", { name: "掲示を検索" }).fill("一致しない検索語");
  await expect(page.getByRole("heading", { name: "条件に一致する掲示はありません" })).toBeVisible();
  await expect(page.getByText("検索キーワードや絞り込み条件を変更してください。")).toBeVisible();
  await page.getByRole("textbox", { name: "掲示を検索" }).fill("");
  await expect(page.getByRole("button", { name: /合成の掲示/ })).toBeVisible();
});

test("MFA QR dialog keeps copy feedback inside and masks secrets again after closing", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, fixture());
  await page.addInitScript(() => {
    Object.defineProperty(window, "chrome", { configurable: true, value: { runtime: { sendMessage: async (message: { type: string }) => {
      if (message.type === "auth-settings") return { ok: true, configured: true, enabled: false, mfaEnabled: true, autoSubmit: true, idHint: "fixture" };
      if (message.type === "auth-get-secrets") return { ok: true, configured: true, totpSecret: "JBSWY3DPEHPK3PXP", temporaryCancelCode: "DUMMY-CANCEL-0123456789" };
      return { ok: true };
    } } } });
    let writes = 0;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { if (++writes > 1) throw new Error("fixture clipboard unavailable"); } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("settings-collapsed.png") });
  const open = page.getByRole("button", { name: "登録情報・QRコードを表示", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "登録情報・QRコード", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: /二段階認証登録用QRコード/ })).toHaveJSProperty("width", 200);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("mfa-qr.png") });
  await dialog.getByRole("button", { name: "手動入力用キーをコピー", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("手動入力用キーをコピーしました。");
  await dialog.getByRole("button", { name: "手動入力用キーを表示", exact: true }).click();
  await expect(dialog.getByText("JBSWY3DPEHPK3PXP", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "一時解除コードを表示", exact: true }).click();
  await expect(dialog.getByText("DUMMY-CANCEL-0123456789", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "一時解除コードをコピー", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("コピーできませんでした");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(dialog.getByText("JBSWY3DPEHPK3PXP", { exact: true })).not.toBeVisible();
  await expect(dialog.getByText("DUMMY-CANCEL-0123456789", { exact: true })).not.toBeVisible();
  await expect(dialog.getByRole("status")).toBeEmpty();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("button", { name: "ダークモードに切り替え" }).click();
  await open.click();
  await expect(dialog.locator(".qr-box")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("mfa-qr-dark.png") });
});

test("course headings name both quarters in each semester", async ({ page }) => {
  await seed(page, courseOverviewFixture());
  await page.clock.setFixedTime(new Date("2026-09-05T12:00:00+09:00"));
  await page.goto("/");
  await page.getByRole("button", { name: "授業", exact: true }).click();
  await expect(page.getByRole("heading", { name: "2026年 春・夏学期" })).toBeVisible();
  await page.clock.setFixedTime(new Date("2026-10-05T12:00:00+09:00"));
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await page.getByRole("button", { name: "授業", exact: true }).click();
  await expect(page.getByRole("heading", { name: "2026年 秋・冬学期" })).toBeVisible();
});

for (const allowTechnicalData of [false, true]) {
  test(`Firefox contact link respects technical data consent (${allowTechnicalData}) without replacing the dashboard`, async ({ page, context }) => {
    await seed(page, fixture());
    await context.route("https://docs.google.com/**", route => route.fulfill({ contentType: "text/html", body: "<p>Synthetic contact form</p>" }));
    await page.addInitScript(allowed => {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Synthetic Firefox test" });
      Object.defineProperty(window, "chrome", { configurable: true, value: {
        runtime: {
          getURL: () => "moz-extension://synthetic-uuid/",
          getManifest: () => ({ version: "1.5.0" }),
          sendMessage: async () => ({ ok: true, configured: false, enabled: false, mfaEnabled: false }),
        },
        permissions: { getAll: async () => ({ data_collection: allowed ? ["technicalAndInteraction"] : [] }) },
      } });
    }, allowTechnicalData);
    await page.goto("/");
    const dashboardUrl = page.url();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "お問い合わせ" }).click(),
    ]);
    await expect.poll(() => popup.url()).toContain("docs.google.com/forms/");
    const params = new URL(popup.url()).searchParams;
    expect(params.get("entry.206461699")).toBe("1.5.0");
    expect(params.get("entry.673140482")).toBe(allowTechnicalData ? "Synthetic Firefox test" : null);
    expect(page.url()).toBe(dashboardUrl);
    await popup.close();
  });
}
