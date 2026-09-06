import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  CLE_CACHE_KEY,
  KOAN_CACHE_KEY,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from "../src/storage";

const ONBOARDING_KEY = "koan-plus-onboarding-v1";
const TOKYO_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Tokyo",
  year: "numeric",
});

function tokyoDateParts(value: Date) {
  return Object.fromEntries(
    TOKYO_DATE_FORMATTER.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
}

function atDay(offset: number, hour = 12, minute = 0) {
  const today = tokyoDateParts(new Date());
  const value = new Date(Date.UTC(
    Number(today.year),
    Number(today.month) - 1,
    Number(today.day),
    hour - 9,
    minute,
  ));
  value.setUTCDate(value.getUTCDate() + offset);
  return value;
}

function dateKey(offset: number) {
  const value = tokyoDateParts(atDay(offset));
  return [
    value.year,
    value.month,
    value.day,
  ].join("-");
}

function specialCaseFixture() {
  const now = new Date();
  const updatedAt = now.toISOString();
  const today = dateKey(0);
  return {
    onboarding: {
      completed: true,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
      acceptedAt: updatedAt,
    },
    koan: {
      schedule: [
        { date: today, period: "1", title: "基礎神経科学", room: "A101", kind: "course" },
        { date: today, period: "2", title: "量子情報特論", room: "オンライン", kind: "course" },
        { date: today, period: "3", title: "長い科目名による表示確認", room: "C304", kind: "course" },
        { date: today, period: "", title: "大学記念日（授業なし）", room: "", kind: "holiday" },
      ],
      courses: [],
      changes: [
        { type: "休講", date: today, period: "1", course: "基礎神経科学" },
        { type: "教室変更", date: today, period: "2", course: "量子情報特論" },
        { type: "補講", date: today, period: "5", course: "未登録の特別補講" },
        { type: "休講", date: "今週", period: "6", course: "日付未確定科目" },
      ],
      surveys: [{
        title: "本日締切の授業アンケート",
        courseName: "基礎神経科学",
        slot: "",
        startAt: atDay(-7).toISOString(),
        endAt: atDay(0, 23, 59).toISOString(),
        status: "回答受付中",
        responseStatus: "未回答",
        completed: false,
        kind: "course",
      }],
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
      tasks: [
        {
          id: "task-1",
          courseId: "course-1",
          courseName: "基礎神経科学",
          title: "同日締切の小テスト",
          dueAt: atDay(0, 18).toISOString(),
          status: "一時保存",
        },
        {
          id: "task-2",
          courseId: "course-1",
          courseName: "基礎神経科学",
          title: "本日締切レポート",
          dueAt: atDay(0, 23, 59).toISOString(),
          status: "未着手",
        },
        {
          id: "task-3",
          courseId: "course-2",
          courseName: "長い科目名による表示確認",
          title: "期限設定なしの課題",
          dueAt: null,
          status: "状態不明",
        },
      ],
      messages: [],
      unreadMessages: 0,
      announcements: [{
        id: "announcement-yesterday",
        courseId: "course-1",
        courseName: "基礎神経科学",
        title: "休講に伴う課題期限の変更",
        body: "<p>次回授業までに提出してください。</p>",
        created: atDay(-1, 9).toISOString(),
      }],
      updatedAt,
      tasksUpdatedAt: updatedAt,
      messagesUpdatedAt: updatedAt,
      coursesUpdatedAt: updatedAt,
      taskStatusesUpdatedAt: updatedAt,
      taskScopeVersion: 3,
      taskStatusCursor: 0,
      announcementsUpdatedAt: updatedAt,
      announcementCourses: {},
      announcementsPendingCount: 0,
      taskStatusPendingCount: 0,
      warnings: [],
    },
  };
}

function emptyFixture() {
  const fixture = specialCaseFixture();
  fixture.koan.schedule = [];
  fixture.koan.changes = [];
  fixture.koan.surveys = [];
  fixture.cle.tasks = [];
  fixture.cle.announcements = [];
  return fixture;
}

async function seed(page: Page, fixture: ReturnType<typeof specialCaseFixture>) {
  await page.addInitScript(({ keys, value }) => {
    localStorage.setItem(keys.onboarding, JSON.stringify(value.onboarding));
    localStorage.setItem(keys.koan, JSON.stringify(value.koan));
    localStorage.setItem(keys.cle, JSON.stringify(value.cle));
    localStorage.setItem("koan-plus-theme", "light");
  }, {
    keys: {
      onboarding: ONBOARDING_KEY,
      koan: KOAN_CACHE_KEY,
      cle: CLE_CACHE_KEY,
    },
    value: fixture,
  });
}

async function expectReachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`special dashboard content remains reachable on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await seed(page, specialCaseFixture());
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
    await expect(page.locator(".app-sidebar").getByRole("link", { name: /KOAN.*新しいタブで開きます/ })).toBeVisible();
    await expectReachable(page.getByText("大学記念日（授業なし）", { exact: true }));
    await expectReachable(page.getByText("未登録の特別補講", { exact: true }));
    await expect(page.locator(".selected-deadline-panel")).toHaveCount(0);

    await expect(page.locator(".next-actions").getByRole("link", { name: /本日締切の授業アンケート/ })).toBeVisible();

    const monthHeading = page.locator(".month-heading h3");
    const initialMonth = await monthHeading.textContent();
    const outsideDay = page.locator(".calendar-days button.outside").first();
    const outsideDayLabel = await outsideDay.getAttribute("aria-label");
    await outsideDay.click();
    await expect(monthHeading).not.toHaveText(initialMonth || "");
    await expect(page.locator(".calendar-days button.selected")).toHaveAttribute("aria-label", outsideDayLabel || "");

    const announcement = page.getByRole("button", {
      name: /休講に伴う課題期限の変更/,
    });
    await expect(announcement).toContainText("昨日");
    await expect(announcement).not.toContainText("期限超過");

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  });
}

test("empty dashboard shows verified empty actions without a duplicate deadline panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, emptyFixture());
  await page.goto("/");

  await expect(page.getByText("この期間の時間割はありません", { exact: true })).toBeVisible();
  await expect(page.locator(".selected-deadline-panel")).toHaveCount(0);
  await expect(page.getByText("対応が必要な課題・締切はありません", { exact: true })).toBeVisible();
});

test("desktop schedule rows contain room and change details without overlapping the next period", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page, specialCaseFixture());
  await page.goto("/");
  const bounds = await page.locator(".rail-schedule-row").evaluateAll((rows) => rows.slice(0, 3).map((row, i) => ({
    bottom: row.getBoundingClientRect().bottom,
    contentBottom: row.querySelector("em")?.getBoundingClientRect().bottom ?? row.querySelector("small")!.getBoundingClientRect().bottom,
    nextTop: rows[i + 1].getBoundingClientRect().top,
  })));
  for (const row of bounds) {
    // Firefox can round two measurements of a shared edge differently (<0.001 CSS px).
    expect(row.contentBottom).toBeLessThanOrEqual(row.bottom + 0.01);
    expect(row.bottom).toBeLessThanOrEqual(row.nextTop + 0.01);
  }
});
