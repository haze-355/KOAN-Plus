import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type MouseEvent,
} from "react";
import DOMPurify from "dompurify";
import {
  BOARD_URL,
  GENRES,
  NOTICE_SNAPSHOT_VERSION,
  PORTAL_URL,
  SURVEYS_URL,
  SNAPSHOT_TTL_MS,
  type ChangeItem,
  type CourseRegistration,
  type GradeData,
  type KoanData,
  type KoanSurvey,
  type Notice,
  type ScheduleItem,
  attentionScore,
  getSnapshotAvailability,
  getKnownNoticeUrl,
  getLightRetryAt,
  getGradesRetryAt,
  isKoanCacheFresh,
  mergeNotices,
  noticeKey,
  refreshGrades,
  refreshLight,
  refreshSnapshot,
  resolveNoticeUrl,
} from "./koan";
import {
  CLE_MESSAGES_URL,
  EMPTY_CLE_DATA,
  type CleData,
  type CleCourse,
  type CleTask,
  type CleAnnouncement,
  type CleMaterial,
  type CleMaterialList,
  cleMessageUrl,
  cleCourseUrl,
  cleTaskUrl,
  downloadCourseMaterial,
  downloadCourseMaterialBatch,
  fetchCourseMaterials,
  getCachedCourseMaterials,
  isMaterialCacheFresh,
  isCleCacheFresh,
  getCleRetryAt,
  refreshCle,
} from "./cle";
import {
  clearCacheStorage,
  exportCacheJson,
  getStorageUsage,
  loadCache,
  loadCleCache,
  loadGradesCache,
  saveCache,
  saveCleCache,
  saveGradesCache,
  type StorageWriteResult,
} from "./storage";
import {
  type AuthSettings,
  claimDashboardRefresh,
  deleteAuthSettings,
  deleteMfaSettings,
  ensureCleLogin,
  ensureKoanLogin,
  academicLinkUrl,
  isFirefoxDataConsentEnv,
  loadAuthSettings,
  refreshCleLogin,
  hasDataCollectionPermission,
  requestAuthenticationInfoPermission,
  saveAuthSettings,
  getSavedMfaSecrets,
  checkLoginStatus,
} from "./auth";
import { buildGpaTrendPoints } from "./grades";
import QRCode from "qrcode";
import ThemeToggle, { loadTheme, saveTheme } from "./ThemeToggle";
import { useEscapeKey } from "./useEscapeKey";
import { activityDateLabel, isRecentActivity } from "./activity";
import { groupDeadlineActions, isUniversityImportant, noticeAttentionReason, upcomingChanges } from "./dashboard";
import { needsMessageRecoveryUpgrade } from "./cle";
import { cleCacheIssue, cleCollectionIssue } from "./cle-status";
import { noticeBenefit } from "./notice-benefits";
import { communicationItems, homeCommunicationGroups, type CommunicationItem } from "./communications";
import {
  coordinateSync, finishSyncAttempt, GRADES_REFRESH_TTL_MS, isSyncFresh,
  MANUAL_REFRESH_TTL_MS, startSyncAttempt, syncRetryAt, type SyncTarget,
} from "./sync";
import { useAutoSync } from "./useAutoSync";
import { KOAN_CACHE_KEY, CLE_CACHE_KEY, GRADES_CACHE_KEY } from "./storage";
import packageJson from "../package.json";


const EMPTY: KoanData = {
  schedule: [],
  courses: [],
  changes: [],
  surveys: [],
  notices: [],
  lightUpdatedAt: null,
  snapshotUpdatedAt: null,
  scheduleUpdatedAt: null,
  futureScheduleUpdatedAt: null,
  coursesUpdatedAt: null,
  changesUpdatedAt: null,
  futureChangesUpdatedAt: null,
  surveysUpdatedAt: null,
  noticesUpdatedAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRecordArrayFields(value: Record<string, unknown>, fields: string[]) {
  return fields.every((field) =>
    Array.isArray(value[field]) && (value[field] as unknown[]).every(isRecord),
  );
}

function isSafeKoanHref(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === "https://koan.osaka-u.ac.jp";
  } catch {
    return false;
  }
}

function loadInitialKoanData(cached: unknown = loadCache<unknown>()): KoanData {
  if (
    !isRecord(cached) ||
    !hasRecordArrayFields(cached, ["schedule", "courses", "changes", "surveys", "notices"]) ||
    !(cached.notices as unknown[]).every((notice) => isRecord(notice) && isSafeKoanHref(notice.href))
  ) {
    return EMPTY;
  }
  return { ...EMPTY, ...cached } as KoanData;
}

function loadInitialCleData(cached: unknown = loadCleCache<unknown>()): CleData {
  if (
    !isRecord(cached) ||
    !hasRecordArrayFields(cached, ["courses", "tasks", "messages"]) ||
    typeof cached.unreadMessages !== "number" ||
    !Number.isFinite(cached.unreadMessages) ||
    (cached.announcements !== undefined && !Array.isArray(cached.announcements)) ||
    (cached.announcementCourses !== undefined && (
      !isRecord(cached.announcementCourses) ||
      !Object.values(cached.announcementCourses).every(isRecord)
    ))
  ) {
    return EMPTY_CLE_DATA;
  }
  return { ...EMPTY_CLE_DATA, ...cached } as CleData;
}

function isGradeData(value: unknown): value is GradeData {
  if (!isRecord(value)) return false;
  return (
    (value.creditsTotal === null || typeof value.creditsTotal === "number") &&
    typeof value.cumulativeGpa === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.termGpas) &&
    (value.termGpas as unknown[]).every(isRecord) &&
    Array.isArray(value.groups) &&
    (value.groups as unknown[]).every((group) =>
      isRecord(group) && Array.isArray(group.courses) &&
      (group.courses as unknown[]).every(isRecord),
    ) &&
    Array.isArray(value.courses) &&
    (value.courses as unknown[]).every(isRecord) &&
    Array.isArray(value.history) &&
    (value.history as unknown[]).every(isRecord)
  );
}

function loadInitialGradesData(cached: unknown = loadGradesCache<unknown>()): GradeData | null {
  return isGradeData(cached) ? cached : null;
}

const fmtTime = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "未取得";

function storageWriteFailure(result: StorageWriteResult) {
  return result.ok
    ? ""
    : `保存に失敗しました（${result.error.kind}）。表示中のデータは保持されています。`;
}

function formatStorageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function latestTimestamp(...values: Array<string | null | undefined>) {
  const timestamps = values.filter((value): value is string => Boolean(value)).sort();
  return timestamps[timestamps.length - 1] || null;
}

function isPartialStatus(value: string) {
  return /一部|以前のデータ|保存済み|未取得/.test(value);
}

const isExpired = (value: string | null, ttl: number) => {
  if (!value) return true;
  const timestamp = new Date(value).getTime();
  const age = Date.now() - timestamp;
  return !Number.isFinite(timestamp) || age < 0 || age >= ttl;
};


function safeDownloadName(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
}

function uniqueDownloadPath(path: string, usedPaths: Set<string>) {
  if (!usedPaths.has(path)) return path;
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = fileName.lastIndexOf(".");
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const extension = dotIndex > 0 ? fileName.slice(dotIndex) : "";
  let suffix = 2;
  while (usedPaths.has(`${directory}${stem} (${suffix})${extension}`)) suffix += 1;
  return `${directory}${stem} (${suffix})${extension}`;
}

function formatFileSize(bytes: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function materialDisplayName(material: CleMaterial) {
  return material.title || material.fileName || "資料";
}

function materialDownloadLabel(material: CleMaterial) {
  return `${materialDisplayName(material)}をダウンロード`;
}

type AppView = "dashboard" | "courses" | "reference" | "grades" | "settings";

/**
 * Progress and success messages. Everything else that lands in a status slot is
 * treated as an error and shown in the same top-bar status slot.
 * Keep the wording here in sync with the setStatus/setCleStatus/... call sites.
 */
const BENIGN_STATUSES = new Set([
  "ログイン状態を確認しています",
  "データを取得しています",
  "自動ログイン完了 / データを取得しています",
  "セッションを再認証しています",
  "KOANログイン完了後に更新します",
  "手動ログインの完了を待っています",
  "更新しています",
  "更新しました",
  "更新をキャンセルしました",
]);

/**
 * KOAN and CLE report separately but usually say the same thing. Label the two
 * sources only when they actually differ - otherwise the user reads one sentence
 * twice for no reason.
 */
function mergeStatuses(koan: string, cle: string) {
  if (!koan) return cle;
  if (!cle || koan === cle) return koan;
  return `KOAN: ${koan} / CLE: ${cle}`;
}

/**
 * Every dialog in the app. Handles the three ways out that a dialog owes the
 * user - Escape, a click on the backdrop, and the button inside - and puts focus
 * in the dialog on open, returning it where it came from on close.
 *
 * Pass `onDismiss={undefined}` for a step that must not be abandoned halfway
 * (registration in flight); the dialog then only closes through its own buttons.
 */
function Modal({
  children,
  className = "",
  labelledBy,
  onDismiss,
  overlayClassName = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  onDismiss?: () => void;
  overlayClassName?: string;
  style?: CSSProperties;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusableElements = () =>
      [...dialog.querySelectorAll<HTMLElement>(
        [
          "a[href]",
          "button:not([disabled])",
          "input:not([disabled])",
          "select:not([disabled])",
          "textarea:not([disabled])",
          '[tabindex]:not([tabindex="-1"])',
        ].join(","),
      )].filter((element) =>
        element.getClientRects().length > 0 &&
        element.getAttribute("aria-hidden") !== "true",
      );

    const initialFocus = focusableElements()[0] || dialog;
    initialFocus.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("keydown", trapFocus);
    return () => {
      dialog.removeEventListener("keydown", trapFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEscapeKey(onDismiss);

  return (
    <div
      className={["settings-modal-overlay", overlayClassName].filter(Boolean).join(" ")}
      onClick={onDismiss}
    >
      <div
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={["settings-modal", className].filter(Boolean).join(" ")}
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        style={style}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

function App({ initialView = "dashboard" }: { initialView?: AppView }) {
  const [theme, setTheme] = useState(loadTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    saveTheme(theme);
  }, [theme]);

  const [data, setData] = useState<KoanData>(loadInitialKoanData);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [loading, setLoading] = useState(false);
  const [cleData, setCleData] = useState<CleData>(loadInitialCleData);
  const cleDataRef = useRef(cleData);
  cleDataRef.current = cleData;
  const [cleLoading, setCleLoading] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState("");
  const [status, setStatus] = useState("");
  const [cleLiveStatus, setCleStatus] = useState("");
  const cleStatus = cleLiveStatus || cleCacheIssue(cleData);
  const [progress, setProgress] = useState("");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [scope, setScope] = useState("all");
  const [view, setView] = useState<AppView>(initialView);
  const [isOffline, setIsOffline] = useState(() =>
    typeof navigator !== "undefined" && navigator.onLine === false,
  );
  const pageTitleRef = useRef<HTMLHeadingElement>(null);
  const syncDetailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const details = syncDetailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const [selectedCourseCode, setSelectedCourseCode] = useState("");
  const [gradesData, setGradesData] = useState<GradeData | null>(loadInitialGradesData);
  const gradesDataRef = useRef(gradesData);
  gradesDataRef.current = gradesData;
  const requestedSyncs = useRef(new Set<SyncTarget>());
  const [syncFeedback, setSyncFeedback] = useState<Partial<Record<SyncTarget, string>>>({});
  const [activeSync, setActiveSync] = useState<SyncTarget | null>(null);
  const [gradesLoading, setGradesLoading] = useState(false);
  const [gradesStatus, setGradesStatus] = useState("");
  const updateLock = useRef(false);
  const authCheckLock = useRef(false);
  const snapshotLock = useRef(false);
  const gradesLock = useRef(false);
  const [authChecking, setAuthChecking] = useState(false);
  const [showManualLoginModal, setShowManualLoginModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<"dashboard" | "grades" | null>(null);
  const [authSettings, setAuthSettings] = useState<AuthSettings | null>(null);
  const autoSyncEnabled = useRef(false);
  autoSyncEnabled.current = Boolean(authSettings?.configured && authSettings.enabled);
  const [freshnessClock, setFreshnessClock] = useState(Date.now());
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<CleAnnouncement | null>(null);
  const [materialCourse, setMaterialCourse] = useState<CourseSummary | null>(null);
  const [materialList, setMaterialList] = useState<CleMaterialList | null>(null);
  const [materialLoading, setMaterialLoading] = useState(false);
  const [materialError, setMaterialError] = useState("");
  const [materialDownloadingId, setMaterialDownloadingId] = useState("");
  const [materialBatchProgress, setMaterialBatchProgress] = useState("");
  const materialRequestId = useRef(0);
  const unsavedResources = useRef(new Set<string>());
  const recordCacheWrite = (key: string, result: StorageWriteResult) => {
    if (result.ok) unsavedResources.current.delete(key);
    else unsavedResources.current.add(key);
    return storageWriteFailure(result);
  };

  useEffect(() => {
    const intervalId = window.setInterval(() => setFreshnessClock(Date.now()), 15 * 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => pageTitleRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  useEffect(() => {
    const refreshAuthSettings = () => {
      void loadAuthSettings()
        .then(setAuthSettings)
        .catch(() => setAuthSettings(null));
    };
    refreshAuthSettings();
    window.addEventListener("focus", refreshAuthSettings);
    return () => window.removeEventListener("focus", refreshAuthSettings);
  }, []);

  const updateKoan = async (refreshRecent = false): Promise<KoanData | null> => {
    setLoading(true);
    setStatus("ログイン状態を確認しています");
    try {
      const data = dataRef.current;
      if (isKoanCacheFresh(data, refreshRecent)) {
        setStatus(`キャッシュ表示中 / 更新 ${fmtTime(data.lightUpdatedAt)}`);
        return data;
      }
      const auth = await ensureKoanLogin();
      if (auth.loginStarted) setStatus("自動ログイン完了 / データを取得しています");
      else setStatus("データを取得しています");
      const result = await refreshLight(data, {
        refreshRecent,
        portalHtml: auth.portalHtml,
        portalUrl: auth.portalUrl,
        onProgress: (value) => {
          if (value) setStatus(value);
        },
      });
      const next = { ...dataRef.current, ...result };
      const writeFailure = recordCacheWrite(KOAN_CACHE_KEY, saveCache(next));
      dataRef.current = next;
      setData(next);
      const refreshedData = next;
      setStatus(
        [
          result.warnings?.length
            ? `一部を以前のデータで表示しています: ${result.warnings.join(" / ")}`
            : "",
          writeFailure,
        ].filter(Boolean).join(" / ") || "更新しました",
      );
      return refreshedData;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setLoading(false);
    }
  };

  const updateCle = async (
    refreshRecent = false,
    activeCoursesTask: Promise<CourseRegistration[]> = Promise.resolve(data.courses),
  ) => {
    setCleLoading(true);
    setCleStatus("ログイン状態を確認しています");
    try {
      const cleData = cleDataRef.current;
      if (isCleCacheFresh(cleData, refreshRecent)) {
        setCleStatus(`キャッシュ表示中 / 更新 ${fmtTime(cleData.updatedAt)}`);
        return true;
      }
      const [auth, activeCourses] = await Promise.all([
        ensureCleLogin(),
        activeCoursesTask,
      ]);
      if (auth.loginStarted) setCleStatus("自動ログイン完了 / データを取得しています");
      else setCleStatus("データを取得しています");
      let next;
      try {
        next = await refreshCle(cleData, auth.tabId, (value) => {
          if (value) setCleStatus(value);
        }, false, {
          refreshRecent,
          activeCourses: activeCourses.map((course) => ({
            code: course.code,
            title: course.title,
            year: course.year,
          })),
          priorityCourseCode: selectedCourseCode,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/別の画面|1分後|待機中|再試行できます/.test(message)) throw error;
        if (!/\((?:401|403)\)|ログイン|認証|セッション/i.test(message)) throw error;
        setCleStatus("セッションを再認証しています");
        const refreshedAuth = await refreshCleLogin();
        next = await refreshCle(cleData, refreshedAuth.tabId, (value) => {
          if (value) setCleStatus(value);
        }, false, {
          refreshRecent,
          activeCourses: activeCourses.map((course) => ({
            code: course.code,
            title: course.title,
            year: course.year,
          })),
          priorityCourseCode: selectedCourseCode,
          bypassBackoff: true,
        });
      }
      const writeFailure = recordCacheWrite(CLE_CACHE_KEY, saveCleCache(next));
      cleDataRef.current = next;
      setCleData(next);
      setCleStatus(
        [
          next.warnings?.length
            ? `一部未取得です: ${next.warnings.join(" / ")}`
            : "",
          writeFailure,
        ].filter(Boolean).join(" / ") || "更新しました",
      );
      // Progressive pagination is useful work, not a failed attempt. Continue
      // the remaining courses promptly; back off when no progress is possible.
      return !next.warnings?.length || next.updatedAt !== cleData.updatedAt ||
        Object.keys(next.announcementCourses || {}).length > Object.keys(cleData.announcementCourses || {}).length ||
        (next.taskStatusPendingCount || 0) < (cleData.taskStatusPendingCount || 0) ||
        (next.messagesPendingCount || 0) < (cleData.messagesPendingCount || 0) ||
        Boolean(next.messagesNextPage && next.messagesNextPage !== cleData.messagesNextPage);
    } catch (error) {
      setCleStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setCleLoading(false);
    }
  };

  const openMaterials = async (course: CourseSummary, force = false) => {
    if (!course.cleCourse || materialDownloadingId || materialBatchProgress) return;
    const requestId = materialRequestId.current + 1;
    materialRequestId.current = requestId;
    const cached = getCachedCourseMaterials(course.cleCourse.courseId);
    setMaterialCourse(course);
    setMaterialList(cached);
    setMaterialError(
      cached?.complete === false
        ? cached.warnings?.join(" / ") || "資料一覧の一部を取得できていません。"
        : "",
    );
    setMaterialBatchProgress("");
    const cacheCanBeShownWithoutRefresh = Boolean(
      !force && cached && isMaterialCacheFresh(cached),
    );
    setMaterialLoading(!cacheCanBeShownWithoutRefresh);
    if (cacheCanBeShownWithoutRefresh) return;

    try {
      // A cached list is useful even when CLE needs to reconnect. Show it
      // immediately and let the refresh continue behind the list.
      const auth = await ensureCleLogin();
      if (requestId !== materialRequestId.current) return;
      const result = await fetchCourseMaterials(course.cleCourse.courseId, auth.tabId, force);
      if (requestId !== materialRequestId.current) return;
      setMaterialList(result);
      setMaterialError(
        result.complete === false
          ? result.warnings?.join(" / ") || "資料一覧の一部を取得できませんでした。"
          : "",
      );
    } catch (error) {
      if (requestId === materialRequestId.current) {
        setMaterialError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === materialRequestId.current) setMaterialLoading(false);
    }
  };

  const materialsBusy = Boolean(materialDownloadingId || materialBatchProgress);

  const downloadMaterial = async (material: CleMaterial) => {
    setMaterialError("");
    setMaterialDownloadingId(material.id);
    try {
      await downloadCourseMaterial(material);
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : String(error));
    } finally {
      setMaterialDownloadingId("");
    }
  };

  const downloadAllMaterials = async () => {
    if (!materialCourse || !materialList?.materials.length) return;
    setMaterialError("");
    setMaterialBatchProgress(`${materialList.materials.length}件を保存中…`);
    try {
      const usedPaths = new Set<string>();
      const courseFolder = safeDownloadName(materialCourse.koan.title) || "CLE資料";
      const entries = materialList.materials.map((material, index) => {
        const basePath = [courseFolder, ...material.folderPath, material.fileName]
          .map(safeDownloadName)
          .filter(Boolean)
          .join("/") || `material-${index + 1}`;
        const path = uniqueDownloadPath(basePath, usedPaths);
        usedPaths.add(path);
        return { material, filePath: path };
      });
      const result = await downloadCourseMaterialBatch(entries);
      if (result.failed.length) {
        setMaterialError(
          `${result.failed.length}件のダウンロードに失敗しました: ${result.failed
            .slice(0, 3)
            .map((failure) => failure.fileName.split("/").pop())
            .join("、")}${result.failed.length > 3 ? " ほか" : ""}`,
        );
      }
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : String(error));
    } finally {
      setMaterialBatchProgress("");
    }
  };

  const executeUpdate = async (refreshRecent = false, sequential = false) => {
    if (updateLock.current) return;
    updateLock.current = true;
    try {
      const claim = await claimDashboardRefresh();
      if (!claim.allowed) {
        requestedSyncs.current.add("dashboard");
        setSyncFeedback((previous) => ({ ...previous, dashboard: "保存済みデータを表示中 · 更新は自動で再試行します" }));
        return;
      }
      if (sequential) {
        setCleStatus("KOANログイン完了後に更新します");
        const refreshedKoan = await updateKoan(refreshRecent);
        if (!refreshedKoan) {
          setCleStatus("KOANログインが完了しなかったため、CLE更新を中止しました");
          return false;
        }
        const cle = await updateCle(refreshRecent, Promise.resolve(refreshedKoan.courses));
        return cle && !refreshedKoan.warnings?.length;
      } else {
        const koanTask = updateKoan(refreshRecent);
        const activeCoursesTask = koanTask.then(
          (refreshedKoan) => refreshedKoan?.courses || data.courses,
        );
        const [koan, cle] = await Promise.all([
          koanTask,
          updateCle(refreshRecent, activeCoursesTask),
        ]);
        return Boolean(koan && !koan.warnings?.length && cle);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      setCleStatus(message);
      return false;
    } finally {
      updateLock.current = false;
    }
  };

  const prepareAuthenticatedAction = async (
    action: "dashboard" | "grades",
  ): Promise<{ manualMode: boolean; mfaEnabled: boolean } | null> => {
    const currentAuthSettings = await loadAuthSettings();
    setAuthSettings(currentAuthSettings);
    if (currentAuthSettings.configured && currentAuthSettings.enabled) {
      return { manualMode: false, mfaEnabled: currentAuthSettings.mfaEnabled };
    }

    const loginStatus = await checkLoginStatus();
    const loggedIn = action === "dashboard"
      ? loginStatus.koanLoggedIn && loginStatus.cleLoggedIn
      : loginStatus.koanLoggedIn;
    if (loggedIn) return { manualMode: true, mfaEnabled: currentAuthSettings.mfaEnabled };

    if (action === "dashboard") {
      setStatus("手動ログインの完了を待っています");
      setCleStatus("手動ログインの完了を待っています");
    } else {
      setGradesStatus("手動ログインの完了を待っています");
    }
    setPendingAction(action);
    setShowManualLoginModal(true);
    return null;
  };

  const cancelManualLogin = () => {
    setShowManualLoginModal(false);
    if (pendingAction === "grades") {
      setGradesStatus("更新をキャンセルしました");
    } else {
      setStatus("更新をキャンセルしました");
      setCleStatus("更新をキャンセルしました");
    }
    setPendingAction(null);
  };

  const runUpdate = async (refreshRecent = false) => {
    if (authCheckLock.current || updateLock.current) return;
    authCheckLock.current = true;
    setAuthChecking(true);
    setStatus("ログイン状態を確認しています");
    setCleStatus("ログイン状態を確認しています");
    let sequential = false;
    try {
      const prepared = await prepareAuthenticatedAction("dashboard");
      if (!prepared) return;
      sequential = !prepared.mfaEnabled;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`ログイン状態を確認できませんでした: ${message}`);
      setCleStatus(`ログイン状態を確認できませんでした: ${message}`);
      return;
    } finally {
      authCheckLock.current = false;
      setAuthChecking(false);
    }
    return executeUpdate(refreshRecent, sequential);
  };
  const update = () => requestSync("dashboard", true);

  const syncSnapshot = async () => {
    if (snapshotLock.current) return;
    snapshotLock.current = true;
    setSnapshotLoading(true);
    setSnapshotStatus("更新しています");
    try {
      setProgress("KOANログイン状態を確認中");
      await ensureKoanLogin();
      const snapshot = await refreshSnapshot(dataRef.current, setProgress);
      const current = dataRef.current;
      const next = {
        ...current,
        ...snapshot,
        notices: mergeNotices([...snapshot.notices, ...current.notices]),
      };
      const writeFailure = recordCacheWrite(KOAN_CACHE_KEY, saveCache(next));
      dataRef.current = next;
      setData(next);
      setSnapshotStatus(
        [
          snapshot.snapshotComplete === false
            ? `一部未取得です: ${snapshot.warnings?.join(" / ") || "次回の同期で続きを取得します"}`
            : "",
          writeFailure,
        ].filter(Boolean).join(" / ") || "更新しました",
      );
      return snapshot.snapshotComplete !== false;
    } catch (error) {
      setSnapshotStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setProgress("");
      setSnapshotLoading(false);
      snapshotLock.current = false;
    }
  };

  const executeGradesUpdate = async () => {
    if (gradesLock.current) return;
    gradesLock.current = true;
    setGradesLoading(true);
    setGradesStatus("ログイン状態を確認しています");
    try {
      const auth = await ensureKoanLogin({ requireTab: true });
      if (!auth.tabId) {
        throw new Error("成績取得に使用するKOANタブを準備できませんでした。");
      }
      setGradesStatus("更新しています");
      const next = await refreshGrades(setGradesStatus, auth.tabId);
      const writeFailure = recordCacheWrite(GRADES_CACHE_KEY, saveGradesCache(next));
      gradesDataRef.current = next;
      setGradesData(next);
      setGradesStatus(writeFailure || "更新しました");
      return true;
    } catch (error) {
      setGradesStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setGradesLoading(false);
      gradesLock.current = false;
    }
  };

  const updateGrades = async () => {
    if (authCheckLock.current || gradesLock.current) return;
    authCheckLock.current = true;
    setAuthChecking(true);
    setGradesStatus("ログイン状態を確認しています");
    try {
      const prepared = await prepareAuthenticatedAction("grades");
      if (!prepared) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGradesStatus(`ログイン状態を確認できませんでした: ${message}`);
      return;
    } finally {
      authCheckLock.current = false;
      setAuthChecking(false);
    }
    return executeGradesUpdate();
  };

  // Read other tabs' completed writes before deciding which endpoints are due.
  // Updating refs as well as React state keeps this decision synchronous.
  const adoptSharedCache = () => {
    const koan = loadCache<unknown>();
    const nextKoan = loadInitialKoanData(koan);
    if (koan && !unsavedResources.current.has(KOAN_CACHE_KEY) && JSON.stringify(nextKoan) !== JSON.stringify(dataRef.current)) {
      if (nextKoan.lightUpdatedAt !== dataRef.current.lightUpdatedAt) {
        setStatus(nextKoan.warnings?.length ? `一部未取得です: ${nextKoan.warnings.join(" / ")}` : "");
      }
      if (nextKoan.snapshotUpdatedAt !== dataRef.current.snapshotUpdatedAt) setSnapshotStatus("");
      dataRef.current = nextKoan;
      setData(nextKoan);
    }
    const cle = loadCleCache<unknown>();
    const nextCle = loadInitialCleData(cle);
    if (cle && !unsavedResources.current.has(CLE_CACHE_KEY) && JSON.stringify(nextCle) !== JSON.stringify(cleDataRef.current)) {
      cleDataRef.current = nextCle;
      setCleData(nextCle);
      setCleStatus(nextCle.warnings?.length ? `一部未取得です: ${nextCle.warnings.join(" / ")}` : "");
    }
    const grades = loadInitialGradesData();
    if (grades && !unsavedResources.current.has(GRADES_CACHE_KEY) && JSON.stringify(grades) !== JSON.stringify(gradesDataRef.current)) {
      gradesDataRef.current = grades;
      setGradesData(grades);
      setGradesStatus("");
    }
  };

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if ([KOAN_CACHE_KEY, CLE_CACHE_KEY, GRADES_CACHE_KEY].includes(event.key || "") &&
          !updateLock.current && !snapshotLock.current && !gradesLock.current) adoptSharedCache();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const syncIsDue = (target: SyncTarget, manual: boolean) => {
    if (target === "dashboard") return !isKoanCacheFresh(dataRef.current, manual) || !isCleCacheFresh(cleDataRef.current, manual);
    if (target === "grades") return !isSyncFresh(gradesDataRef.current?.updatedAt, manual ? MANUAL_REFRESH_TTL_MS : GRADES_REFRESH_TTL_MS);
    return dataRef.current.snapshotVersion !== NOTICE_SNAPSHOT_VERSION ||
      dataRef.current.snapshotComplete === false || !isSyncFresh(dataRef.current.snapshotUpdatedAt, SNAPSHOT_TTL_MS);
  };

  const requestSync = async (target: SyncTarget, manual = false, loginApproved = false, scheduled = false) => {
    if (manual) requestedSyncs.current.add(target);
    const feedback = (message: string) => setSyncFeedback((previous) => ({ ...previous, [target]: message }));
    if (navigator.onLine === false) {
      if (manual) feedback("保存済みデータを表示中 · 接続後に自動で確認します");
      return;
    }
    let attemptStarted = false;
    const acquired = await coordinateSync(async () => {
      adoptSharedCache();
      if (!syncIsDue(target, manual)) {
        requestedSyncs.current.delete(target);
        if (manual) feedback("直近の確認結果を、通信せずに表示しています");
        return;
      }
      const resourceRetryAt = target === "reference" ? getSnapshotAvailability().blockedUntil
        : target === "grades" ? getGradesRetryAt()
        : Math.max(
          isKoanCacheFresh(dataRef.current, manual) ? 0 : getLightRetryAt(),
          isCleCacheFresh(cleDataRef.current, manual) ? 0 : getCleRetryAt(),
        );
      // The upgraded terminal check gets one attempt without inheriting the
      // legacy pagination failure's scheduler penalty. Resource leases and
      // the one-minute request cooldown remain in force.
      const recoveryUpgrade = target === "dashboard" && needsMessageRecoveryUpgrade(cleDataRef.current);
      const retryAt = Math.max(resourceRetryAt, recoveryUpgrade ? 0 : syncRetryAt(target, manual && !scheduled));
      if (retryAt > Date.now() && !loginApproved) {
        if (manual) feedback("保存済みデータを表示中 · 更新は自動で再試行します");
        return;
      }
      requestedSyncs.current.delete(target);
      feedback("");
      startSyncAttempt(target);
      attemptStarted = true;
      setActiveSync(target);
      let succeeded = false;
      let completedAttempt = false;
      try {
        const result = target === "dashboard"
          ? await (loginApproved ? executeUpdate(manual, true) : runUpdate(manual))
          : target === "reference" ? await syncSnapshot()
          : await (loginApproved ? executeGradesUpdate() : updateGrades());
        succeeded = result === true;
        completedAttempt = result !== undefined;
        if (manual && completedAttempt && (result === false || syncIsDue(target, false))) requestedSyncs.current.add(target);
      } finally {
        // A denied lease or a login prompt did not attempt a resource fetch.
        if (completedAttempt) finishSyncAttempt(target, succeeded);
        setActiveSync(null);
      }
    }).catch((error: unknown) => {
      feedback("");
      const message = error instanceof Error ? error.message : String(error);
      if (target === "grades") setGradesStatus(message);
      else if (target === "reference") setSnapshotStatus(message);
      else setStatus(message);
      // Authentication or extension messaging may fail before a resource starts.
      if (manual) requestedSyncs.current.add(target);
      if (!attemptStarted) finishSyncAttempt(target, false);
      return true;
    });
    if (!acquired && manual) feedback("別の更新が進行中です · 完了後に自動で確認します");
  };

  useAutoSync(async () => {
    if (showManualLoginModal || authCheckLock.current) return;
    const preferred: SyncTarget = view === "grades" ? "grades" : view === "reference" ? "reference" : "dashboard";
    const targets = [...new Set<SyncTarget>([...requestedSyncs.current, preferred, "dashboard", "grades", "reference"])];
    for (const target of targets) {
      if (document.visibilityState === "hidden" || navigator.onLine === false) break;
      const manual = requestedSyncs.current.has(target);
      if (!manual && (!autoSyncEnabled.current || !syncIsDue(target, false))) continue;
      await requestSync(target, manual, false, true);
    }
  }, `${view}:${Boolean(authSettings?.configured && authSettings.enabled)}`);

  const notices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.notices
      .filter((notice) => {
        const text = [notice.title, notice.department, notice.author]
          .join(" ")
          .toLowerCase();
        if (needle && !text.includes(needle)) return false;
        if (genre && notice.genre !== genre) return false;
        if (scope === "unread" && !notice.unread) return false;
        if (scope === "important" && !isImportantNotice(notice)) return false;
        if (scope === "attention" && attentionScore(notice) < 120) return false;
        if (scope === "benefits" && !noticeBenefit(notice)) return false;
        return true;
      })
      .sort((a, b) => Number(isImportantNotice(b)) - Number(isImportantNotice(a)) || attentionScore(b) - attentionScore(a));
  }, [data.notices, genre, query, scope]);

  const snapshotExpired =
    data.snapshotVersion !== NOTICE_SNAPSHOT_VERSION ||
    isExpired(data.snapshotUpdatedAt, SNAPSHOT_TTL_MS);
  const snapshotAvailability = getSnapshotAvailability();
  const snapshotNow = Math.max(freshnessClock, Date.now());
  const snapshotBlocked = snapshotAvailability.blockedUntil > snapshotNow;
  const snapshotWaitMinutes = Math.max(
    1,
    Math.ceil((snapshotAvailability.blockedUntil - snapshotNow) / (60 * 1000)),
  );
  const snapshotBlockedStatus = snapshotAvailability.reason === "syncing"
    ? "別の画面で掲示を同期中です"
    : snapshotAvailability.reason === "resolving"
      ? "掲示を検索中です"
      : snapshotAvailability.reason === "completed"
        ? `掲示同期 ${fmtTime(data.snapshotUpdatedAt)}`
        : `掲示同期の再試行まで約${snapshotWaitMinutes}分`;
  const markNoticeRead = (openedNotice: Notice) => {
    const openedKey = noticeKey(openedNotice);
    const current = dataRef.current;
    const notices = current.notices.map((notice) =>
      noticeKey(notice) === openedKey ? { ...notice, unread: false } : notice,
    );
    const next = { ...current, notices };
    const writeFailure = recordCacheWrite(KOAN_CACHE_KEY, saveCache(next));
    dataRef.current = next;
    setData(next);
    if (writeFailure) setStatus(writeFailure);
  };

  const updateTimes = [
    data.scheduleUpdatedAt,
    data.futureScheduleUpdatedAt,
    data.coursesUpdatedAt,
    data.changesUpdatedAt,
    data.futureChangesUpdatedAt,
    data.surveysUpdatedAt,
    data.noticesUpdatedAt,
    cleData.coursesUpdatedAt,
    cleData.tasksUpdatedAt,
    cleData.messagesUpdatedAt,
    cleData.taskStatusesUpdatedAt,
  ];
  const latestUpdatedAt = updateTimes.every(Boolean)
    ? (() => {
      const sorted = [...(updateTimes as string[])].sort();
      return sorted[sorted.length - 1] || null;
    })()
    : null;
  const viewTitle = {
    dashboard: "ホーム",
    courses: "授業",
    reference: "掲示",
    grades: "成績",
    settings: "設定",
  }[view];
  // Status strings come from several refresh layers. Partial/cache-retained
  // results are warnings, not hard failures: they must remain visible without
  // turning the top bar into an assertive error alert.
  const isBenign = (value: string) =>
    !value || value.includes("キャッシュ表示中") || isPartialStatus(value) || BENIGN_STATUSES.has(value);
  const showGradesError = !gradesLoading && !authChecking && !isBenign(gradesStatus);
  const hasKoanError = !loading && !authChecking && !isBenign(status);
  const hasCleError = !cleLoading && !authChecking && !isBenign(cleStatus);
  const showGradesPartial = !showGradesError && isPartialStatus(gradesStatus);
  const hasKoanPartial = !hasKoanError && isPartialStatus(status);
  const hasClePartial = !hasCleError && isPartialStatus(cleStatus);
  const showUpdateError = hasKoanError || hasCleError;
  const showUpdatePartial = hasKoanPartial || hasClePartial;
  const snapshotError = !isBenign(snapshotStatus) && !snapshotLoading;
  const snapshotPartial = !snapshotError && !snapshotLoading && isPartialStatus(snapshotStatus);
  const courseStatus = showUpdateError || showUpdatePartial
    ? mergeStatuses(status, cleStatus)
    : "";

  const autoLoginActive = Boolean(authSettings?.configured && authSettings.enabled);

  // The same cache-first action is available on every screen. Fresh data never
  // triggers authentication, and deferred work remains visible without an error.
  const topbarState = view === "reference" ? {
    action: () => requestSync("reference", true),
    busy: snapshotLoading,
    label: snapshotLoading ? "更新中…" : "更新",
    status: snapshotLoading
      ? (progress || "掲示を同期しています")
      : snapshotError
      ? snapshotStatus
        : snapshotBlocked
          ? snapshotBlockedStatus
          : snapshotPartial
            ? snapshotStatus
          : `最終更新 ${fmtTime(data.snapshotUpdatedAt)}${snapshotExpired ? " / 更新できます" : ""}`,
  } : view === "grades" ? {
    action: () => requestSync("grades", true),
    busy: gradesLoading || authChecking,
    label: gradesLoading || authChecking ? "更新中…" : "更新",
    status: gradesLoading || authChecking
      ? (gradesStatus || "成績を取得しています")
      : showGradesError
        ? gradesStatus
        : showGradesPartial
          ? gradesStatus
        : `最終更新 ${fmtTime(gradesData?.updatedAt ?? null)}`,
  } : {
    action: () => requestSync("dashboard", true),
    busy: loading || cleLoading || authChecking,
    label: loading || cleLoading || authChecking ? "更新中…" : "更新",
    status: loading || cleLoading || authChecking
      ? mergeStatuses(status, cleStatus) || "更新しています"
      : showUpdateError
        ? mergeStatuses(hasKoanError ? status : "", hasCleError ? cleStatus : "")
        : showUpdatePartial
          ? mergeStatuses(hasKoanPartial ? status : "", hasClePartial ? cleStatus : "")
        : `最終更新 ${fmtTime(latestUpdatedAt)}`,
  };
  const currentSyncTarget: SyncTarget = view === "reference" ? "reference" : view === "grades" ? "grades" : "dashboard";
  const currentFeedback = topbarState.busy ? "" : syncFeedback[currentSyncTarget];
  const topbarStatus = currentFeedback || (
    topbarState.busy && currentSyncTarget === "dashboard"
      ? authChecking ? "ログイン状態を確認しています" : "授業・課題・連絡を確認しています"
      : topbarState.status
  );
  const syncHasIssue = showUpdateError || showUpdatePartial || snapshotError || snapshotPartial || showGradesError || showGradesPartial;
  const koanLoaded = Boolean(
    data.lightUpdatedAt ||
    data.snapshotUpdatedAt ||
    data.surveysUpdatedAt ||
    data.noticesUpdatedAt,
  );
  const cleLoaded = Boolean(
    cleData.updatedAt ||
    cleData.messagesUpdatedAt ||
    cleData.tasksUpdatedAt ||
    cleData.taskStatusesUpdatedAt,
  );

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={() => document.getElementById("main-content")?.focus()}
      >
        本文へ移動
      </a>
      <Sidebar
        onViewChange={setView}
        view={view}
      />

      <header className={`app-topbar${activeSync ? " is-syncing" : ""}`}>
        <h1 ref={pageTitleRef} tabIndex={-1}>{viewTitle}</h1>
        <div className="topbar-actions">
          <div className="update-group">
            <details ref={syncDetailsRef} key={view} className="sync-details" onBlur={(event) => {
              if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
            }} onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}>
              <summary className={syncHasIssue ? "has-issue" : ""}>
                <span className={`sync-indicator${activeSync ? " is-active" : ""}`} aria-hidden="true" />
                <span role="status" aria-live="polite">{isOffline ? "オフライン · 保存済みを表示" : activeSync
                  ? `${({ dashboard: "ホーム", reference: "掲示", grades: "成績" })[activeSync]}を同期中`
                  : currentFeedback || (syncHasIssue ? "一部の情報を更新できませんでした" : topbarStatus)}</span>
                <span className="sr-only">同期の詳細</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="lucide-icon sync-chevron"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </summary>
              <div className="sync-popover" aria-label="同期の詳細">
                <div className="sync-popover-heading"><strong>同期の状態</strong><span>保存済みの情報は引き続き閲覧できます</span></div>
                {isOffline && <p className="sync-offline-note">{autoLoginActive || requestedSyncs.current.size > 0 ? "接続後に自動同期を再開します。" : "接続後に更新できます。"}</p>}
                <SourceStatus source="KOAN" loaded={koanLoaded} loading={loading || authChecking} error={hasKoanError} status={status} updatedAt={latestTimestamp(data.lightUpdatedAt, data.surveysUpdatedAt, data.noticesUpdatedAt)} onRetry={() => void requestSync("dashboard", true)} />
                <SourceStatus source="CLE" loaded={cleLoaded} loading={cleLoading} error={hasCleError} status={cleStatus} updatedAt={latestTimestamp(cleData.updatedAt, cleData.messagesUpdatedAt, cleData.tasksUpdatedAt)} onRetry={() => void requestSync("dashboard", true)} />
                <SourceStatus source="掲示" loaded={Boolean(data.snapshotUpdatedAt)} loading={snapshotLoading} error={snapshotError} status={snapshotStatus} updatedAt={data.snapshotUpdatedAt} stale={snapshotExpired} onRetry={() => void requestSync("reference", true)} />
                <SourceStatus source="成績" loaded={Boolean(gradesData)} loading={gradesLoading} error={showGradesError} status={gradesStatus} updatedAt={gradesData?.updatedAt ?? null} onRetry={() => void requestSync("grades", true)} />
              </div>
            </details>
            <button
              className={topbarState.busy ? "is-loading" : ""}
              type="button"
              disabled={topbarState.busy}
              onClick={topbarState.action}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`lucide-icon refresh-icon${topbarState.busy ? " spinner" : ""}`}
                aria-hidden="true"
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
              {topbarState.label}
            </button>
          </div>
          <ThemeToggle onToggle={() => setTheme(theme === "light" ? "dark" : "light")} theme={theme} />
        </div>
      </header>

      <main
        className={view === "dashboard" ? "dashboard-layout" : "page-layout"}
        id="main-content"
        tabIndex={-1}
      >
        {view === "dashboard" ? (
          <Dashboard
            cleData={cleData}
            cleLoading={cleLoading}
            koanIssue={hasKoanError || hasKoanPartial ? status : ""}
            cleIssue={hasCleError || hasClePartial ? cleStatus : ""}
            onRetry={update}
            onShowNotices={() => setView("reference")}
            data={data}
            loading={loading || authChecking}
            onOpenNotice={markNoticeRead}
            onSelectCourse={(code) => {
              setSelectedCourseCode(code);
              setView("courses");
            }}
            onOpenAnnouncement={setSelectedAnnouncement}
          />
        ) : view === "courses" ? (
          <CoursesPage
            cleData={cleData}
            data={data}
            loading={loading || cleLoading || authChecking}
            status={courseStatus}
            error={showUpdateError}
            loaded={koanLoaded || cleLoaded}
            onOpenNotice={markNoticeRead}
            selectedCode={selectedCourseCode}
            onSelectCode={setSelectedCourseCode}
            onOpenAnnouncement={setSelectedAnnouncement}
            onOpenMaterials={openMaterials}
            materialsBusy={materialsBusy}
            materialsPanel={materialCourse?.code === selectedCourseCode ? <CourseMaterialsContent
              list={materialList} loading={materialLoading} error={materialError}
              downloadingId={materialDownloadingId} batchProgress={materialBatchProgress}
              onDownload={downloadMaterial} onDownloadAll={downloadAllMaterials}
              onRefresh={() => void openMaterials(materialCourse, true)}
            /> : null}
          />
        ) : view === "reference" ? (
          <ReferenceDesk
            genre={genre}
            allNotices={data.notices}
            notices={notices}
            loading={snapshotLoading}
            error={snapshotError ? snapshotStatus : ""}
            partial={snapshotPartial ? snapshotStatus : ""}
            loaded={Boolean(data.snapshotUpdatedAt || data.noticesUpdatedAt)}
            onGenreChange={setGenre}
            onOpen={markNoticeRead}
            onQueryChange={setQuery}
            onScopeChange={setScope}
            query={query}
            scope={scope}
          />
        ) : view === "grades" ? (
          <Grades
            data={gradesData}
            loading={gradesLoading || authChecking}
            status={gradesStatus}
          />
        ) : <Settings onAuthSettingsChange={setAuthSettings} />}
      </main>

      {showManualLoginModal && (
        <Modal labelledBy="manual-login-title" onDismiss={cancelManualLogin}>
          <h3 className="modal-title" id="manual-login-title">手動でログインを行いますか</h3>
          <p className="modal-text">
            自動ログインが無効、またはログイン情報が設定されていないため、大阪大学の公式ログイン画面（新しいタブ）を開いて手動でログインする必要があります。
          </p>
          <p className="modal-note">
            ※ログインが完了すると、自動的にこのダッシュボードに戻り、データが取得されます。（IDやパスワードは保存されません）
          </p>
          <div className="modal-actions">
            <button className="modal-btn cancel" onClick={cancelManualLogin} type="button">
              キャンセル
            </button>
            <button className="modal-btn confirm" onClick={() => {
              setShowManualLoginModal(false);
              const action = pendingAction;
              setPendingAction(null);
              if (action === "grades") {
                void requestSync("grades", true, true);
              } else {
                void requestSync("dashboard", true, true);
              }
            }} type="button">
              ログイン画面を開く
            </button>
          </div>
        </Modal>
      )}

      {selectedAnnouncement && (
        <Modal
          className="announcement-modal"
          labelledBy="announcement-modal-title"
          onDismiss={() => setSelectedAnnouncement(null)}
        >
          <h3 className="modal-title" id="announcement-modal-title">{selectedAnnouncement.title}</h3>
          <p className="modal-meta">
            {courseDisplayName(selectedAnnouncement.courseName)} / {fmtDue(selectedAnnouncement.created)}
          </p>
          <div
            className="announcement-modal-body markdown-body"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selectedAnnouncement.body) }}
          />
          <div className="modal-actions">
            <button className="modal-btn cancel" onClick={() => setSelectedAnnouncement(null)} type="button">
              閉じる
            </button>
          </div>
        </Modal>
      )}


    </div>
  );
}

function getContactUrl(includeUserAgent = true) {
  const baseUrl = "https://docs.google.com/forms/d/e/1FAIpQLSdo3KmL2KnbDLtqgQfjtqO2NG7W6M0rTVeEJ4I5aPyJ2HsQyA/viewform";
  const chromeObj = typeof window !== "undefined" ? (window as any).chrome : undefined;
  const version = chromeObj && chromeObj.runtime?.getManifest
    ? chromeObj.runtime.getManifest().version
    : packageJson.version;

  const params = new URLSearchParams();
  params.append("entry.206461699", version);
  if (includeUserAgent) {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
    params.append("entry.673140482", ua);
  }

  return `${baseUrl}?${params.toString()}`;
}

function Sidebar({
  onViewChange,
  view,
}: {
  onViewChange: (view: AppView) => void;
  view: AppView;
}) {
  const items = [
    ["dashboard", "ホーム"],
    ["courses", "授業"],
    ["reference", "掲示"],
    ["grades", "成績"],
    ["settings", "設定"],
  ] as const;

  const firefox = isFirefoxDataConsentEnv();
  const contactUrl = getContactUrl(!firefox);
  const handleContactClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!firefox) return;
    event.preventDefault();
    // permission確認後ではpopupが遮断され得るため、Firefoxのuser activation中に空タブを確保する。
    const contactWindow = window.open("about:blank", "_blank");
    if (contactWindow) contactWindow.opener = null;
    void hasDataCollectionPermission("technicalAndInteraction").then((includeUserAgent) => {
      const url = getContactUrl(includeUserAgent);
      if (contactWindow && !contactWindow.closed) {
        contactWindow.location.href = url;
      } else {
        window.location.href = url;
      }
    });
  };

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span>KOAN</span>
        <b>Plus</b>
      </div>
      <nav className="side-nav" aria-label="画面切替">
        {items.map(([key, label]) => (
          <button
            aria-current={view === key ? "page" : undefined}
            className={view === key ? "active" : ""}
            key={key}
            onClick={() => onViewChange(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <small>外部リンク</small>
        <AuthenticatedLink href={PORTAL_URL} target="_blank">KOAN</AuthenticatedLink>
        <AuthenticatedLink href={CLE_MESSAGES_URL} target="_blank">CLE</AuthenticatedLink>
        <ExternalLink href={contactUrl} onClick={firefox ? handleContactClick : undefined}>お問い合わせ</ExternalLink>
      </div>
    </aside>
  );
}

// Normal navigation starts immediately. If the session expired, the official
// page redirects to login and auth-content.js applies the user's saved settings.
function AuthenticatedLink(props: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string }) {
  const href = academicLinkUrl(props.href);
  if (!href) return <span className={props.className}>{props.children}<span className="inline-error" role="alert">リンク先を確認できませんでした。</span></span>;
  return <ExternalLink {...props} href={href} />;
}

function NewTabNotice() {
  return <span className="sr-only">（新しいタブで開きます）</span>;
}

function ExternalLink({
  children,
  rel = "noopener noreferrer",
  target = "_blank",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...props} rel={rel} target={target}>
      {children}
      {target === "_blank" && <NewTabNotice />}
    </a>
  );
}

const EMPTY_AUTH_SETTINGS: AuthSettings = {
  configured: false,
  enabled: false,
  autoSubmit: true,
  mfaEnabled: false,
  idHint: "",
};

function Settings({
  onAuthSettingsChange,
}: {
  onAuthSettingsChange?: (settings: AuthSettings) => void;
}) {
  const [settings, setSettings] = useState(EMPTY_AUTH_SETTINGS);
  const [persistedSettings, setPersistedSettings] = useState(EMPTY_AUTH_SETTINGS);
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [mfaConsent, setMfaConsent] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingCredentials, setEditingCredentials] = useState(false);
  const [setupStarted, setSetupStarted] = useState(false);
  const [setupStep, setSetupStep] = useState<1 | 2 | 3>(1);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showMfaDeleteModal, setShowMfaDeleteModal] = useState(false);
  const [savedSecrets, setSavedSecrets] = useState<{
    totpSecret: string;
    temporaryCancelCode: string;
  } | null>(null);
  const [showCancelCode, setShowCancelCode] = useState(false);
  const [showMfaSecret, setShowMfaSecret] = useState(false);
  const [mfaCopyStatus, setMfaCopyStatus] = useState("");
  const [showMfaWizardModal, setShowMfaWizardModal] = useState(false);
  const [mfaWizardStep, setMfaWizardStep] = useState<"consent" | "registering" | "qr">("consent");
  const [mfaConsentChecked1, setMfaConsentChecked1] = useState(false);
  const [mfaConsentChecked2, setMfaConsentChecked2] = useState(false);
  const [mfaRegistrationTimedOut, setMfaRegistrationTimedOut] = useState(false);
  const mfaRegistrationTimeoutRef = useRef<number | null>(null);
  const mfaRegistrationTabIdRef = useRef<number | null>(null);
  const mfaRegistrationCleanupRef = useRef<(() => void) | null>(null);
  const settingsMountedRef = useRef(true);
  const [storageUsage, setStorageUsage] = useState(() => getStorageUsage());
  const [showCacheDeleteModal, setShowCacheDeleteModal] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);

  const reloadSettings = async () => {
    try {
      const next = await loadAuthSettings();
      setSettings(next);
      setPersistedSettings(next);
      onAuthSettingsChange?.(next);
      setMfaEnabled(next.mfaEnabled);
      setMfaConsent(next.mfaEnabled);
      if (next.configured) setSetupStarted(false);
      try {
        const secrets = await getSavedMfaSecrets();
        if (secrets.configured && secrets.totpSecret) {
          const nextSecrets = {
            totpSecret: secrets.totpSecret,
            temporaryCancelCode: secrets.temporaryCancelCode || "",
          };
          setSavedSecrets(nextSecrets);
          return nextSecrets;
        }
      } catch (e) {
        console.error("Failed to load saved MFA secrets:", e);
      }
      setSavedSecrets(null);
      return null;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  useEffect(() => {
    void reloadSettings();

    const handleFocus = () => {
      void reloadSettings();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  useEffect(() => {
    setStorageUsage(getStorageUsage());
  }, []);

  useEffect(() => {
    if (!showMfaWizardModal) return;
    const titleId = `mfa-wizard-title-${mfaWizardStep}`;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(titleId)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mfaWizardStep, showMfaWizardModal]);

  useEffect(() => {
    settingsMountedRef.current = true;
    return () => {
      settingsMountedRef.current = false;
      mfaRegistrationCleanupRef.current?.();
      if (mfaRegistrationTimeoutRef.current !== null) {
        window.clearTimeout(mfaRegistrationTimeoutRef.current);
        mfaRegistrationTimeoutRef.current = null;
      }
    };
  }, []);

  const hasSavedMfa = Boolean(savedSecrets?.totpSecret);
  const maskedTotpSecret = savedSecrets?.totpSecret ? "••••••••" : "";
  const maskedCancelCode = savedSecrets?.temporaryCancelCode ? "••••••••" : "";
  const setupCanGoNext = Boolean(id.trim() && password);
  const canSaveCredentials = !saving && Boolean(id.trim() && password);
  const canFinishSetup = !saving && Boolean(id.trim() && password) && (!mfaEnabled || (mfaConsent && Boolean(hasSavedMfa || totpSecret.trim())));
  const canSaveManualTotp = !saving && settings.mfaEnabled && Boolean(totpSecret.trim());

  const refreshStorageUsage = () => setStorageUsage(getStorageUsage());
  const managedStorageBytes = storageUsage.entries
    .filter((entry) => entry.managed)
    .reduce((total, entry) => total + entry.utf8Bytes, 0);

  const exportCache = () => {
    const result = exportCacheJson();
    if (!result.ok) {
      setStatus(`キャッシュを書き出せませんでした: ${result.error.message}`);
      return;
    }
    try {
      const blob = new Blob([result.json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `koan-plus-cache-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`キャッシュを書き出しました（${formatStorageBytes(result.bytes)}）。認証情報は含まれていません。`);
    } catch (error) {
      setStatus(`キャッシュを書き出せませんでした: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const clearCache = () => {
    setCacheClearing(true);
    const result = clearCacheStorage();
    refreshStorageUsage();
    setShowCacheDeleteModal(false);
    setCacheClearing(false);
    if (!result.ok) {
      setStatus(`キャッシュの削除に一部失敗しました（${result.failed.length}件）。表示中のデータは保持されています。`);
      return;
    }
    setStatus(`キャッシュを${result.removed.length}件削除しました。認証情報・テーマ・同意は保持されます。`);
    window.setTimeout(() => window.location.reload(), 150);
  };

  const startAutoCollect = async () => {
    const chromeObj = typeof window !== "undefined" ? (window as any).chrome : undefined;
    if (chromeObj && chromeObj.tabs?.create) {
      setSaving(true);
      try {
        const pending = await chromeObj.runtime.sendMessage({ type: "auth-focus-pending-mfa" });
        if (pending?.found) {
          setSaving(false);
          setStatus("先に前面へ移動した二段階認証を完了してください。完了後にMFA登録を開始できます。");
          setShowMfaWizardModal(false);
          return;
        }
      } catch (error) {
        setSaving(false);
        setStatus(error instanceof Error ? error.message : "認証待ちタブを確認できませんでした。");
        setShowMfaWizardModal(false);
        return;
      }
      
      chromeObj.tabs.create({
        url: "about:blank",
        active: false
      }, (tab: any) => {
        if (!tab || !tab.id) {
          setSaving(false);
          setStatus("バックグラウンドタブの作成に失敗しました。");
          setShowMfaWizardModal(false);
          return;
        }
        if (!settingsMountedRef.current) {
          void Promise.resolve(chromeObj.tabs.remove(tab.id)).catch(() => {});
          return;
        }

        mfaRegistrationTabIdRef.current = tab.id;
        setMfaRegistrationTimedOut(false);
        // 12秒のセーフティタイマー（ログイン要求やエラー等で進まない場合に前面に出す）
        const timeoutId = window.setTimeout(() => {
          setMfaRegistrationTimedOut(true);
          if (chromeObj.tabs?.update) {
            chromeObj.tabs.update(tab.id, { active: true });
            setStatus("自動ログインが長引いているため、タブを前面に表示しました。完了しない場合は登録を閉じて再試行できます。");
          }
        }, 12000);
        mfaRegistrationTimeoutRef.current = timeoutId;

        let listener: (tabId: number) => void = () => {};
        const cleanupRegistration = () => {
          if (chromeObj.tabs?.onRemoved?.removeListener) {
            chromeObj.tabs.onRemoved.removeListener(listener);
          }
          if (mfaRegistrationTimeoutRef.current === timeoutId) {
            window.clearTimeout(timeoutId);
            mfaRegistrationTimeoutRef.current = null;
          }
          if (mfaRegistrationTabIdRef.current === tab.id) {
            mfaRegistrationTabIdRef.current = null;
          }
          if (mfaRegistrationCleanupRef.current === cleanupRegistration) {
            mfaRegistrationCleanupRef.current = null;
          }
        };

        // タブが閉じられたことを検知してリロード
        listener = (tabId: number) => {
          if (tabId === tab.id) {
            cleanupRegistration();
            
            void chromeObj.runtime.sendMessage({
              type: "auth-mfa-registration-result",
              tabId,
            }).then(async (result: any) => {
              const secrets = await reloadSettings();
              setSaving(false);
              if (result?.status === "saved" && secrets?.totpSecret) {
                setStatus("二段階認証の登録を保存しました。今後はこの端末で6桁コードを生成できます。");
                setMfaWizardStep("qr");
                return;
              }
              setMfaWizardStep("consent");
              setShowMfaWizardModal(false);
              setStatus(result?.error || "MFA登録を完了できませんでした。登録画面を閉じずに、もう一度実行してください。");
            }).catch((e: Error) => {
              setSaving(false);
              setMfaWizardStep("consent");
              setShowMfaWizardModal(false);
              setStatus(`MFA登録の完了状態を確認できませんでした: ${e.message}`);
            });
          }
        };
        chromeObj.tabs.onRemoved.addListener(listener);
        mfaRegistrationCleanupRef.current = cleanupRegistration;

        // バックグラウンドに自動取得対象タブとして登録
        chromeObj.runtime.sendMessage({
          type: "auth-mfa-register-auto-tab",
          tabId: tab.id
        }, (response: any) => {
          if (!response?.ok) {
            cleanupRegistration();
            void Promise.resolve(chromeObj.tabs.remove(tab.id)).catch(() => {});
            setSaving(false);
            setMfaWizardStep("consent");
            setStatus(response?.error || "自動取得タブの登録に失敗しました。");
            setShowMfaWizardModal(false);
            return;
          }
          chromeObj.tabs.update(tab.id, {
            url: "https://auth-mfa.auth.osaka-u.ac.jp/AttributeRegistSite/MfaInfoServlet#auto-collect"
          });
        });
      });
    } else {
      setStatus("自動取得は拡張機能のポップアップまたはオプション画面から実行してください。");
      setShowMfaWizardModal(false);
    }
  };

  const cancelMfaRegistration = () => {
    const tabId = mfaRegistrationTabIdRef.current;
    const chromeObj = typeof window !== "undefined" ? (window as any).chrome : undefined;
    mfaRegistrationCleanupRef.current?.();
    if (tabId === null || !chromeObj) return;
    try {
      // Newer background workers can clear their registration bookkeeping
      // before the tab is removed. Older workers simply ignore this message.
      void Promise.resolve(
        chromeObj.runtime?.sendMessage?.({ type: "auth-mfa-cancel-auto-tab", tabId }),
      ).catch(() => {});
    } catch {
      // The tab removal below is still enough to release the UI-side state.
    }
    try {
      void Promise.resolve(chromeObj.tabs?.remove?.(tabId)).catch(() => {});
    } catch {
      // The tab may already have been closed by the user.
    }
  };

  const handleStartRegister = async () => {
    if (!await requestAuthenticationInfoPermission()) {
      setStatus("MFA自動登録を使用するには認証情報の利用許可が必要です。Firefoxの許可を確認してください。");
      setShowMfaWizardModal(false);
      return;
    }
    setMfaRegistrationTimedOut(false);
    setMfaWizardStep("registering");
    await startAutoCollect();
  };

  const closeMfaWizard = () => {
    cancelMfaRegistration();
    setSaving(false);
    setMfaRegistrationTimedOut(false);
    setShowMfaWizardModal(false);
    setShowMfaSecret(false);
    setShowCancelCode(false);
    setMfaCopyStatus("");
    setMfaWizardStep("consent");
  };

  const qrCanvasRef = (node: HTMLCanvasElement | null) => {
    if (node && savedSecrets?.totpSecret) {
      const uri = `otpauth://totp/osaka-u?secret=${savedSecrets.totpSecret}&issuer=osaka-u`;
      QRCode.toCanvas(node, uri, { width: 200, margin: 2 }, (error) => {
        if (error) console.error("Failed to generate QR code:", error);
      });
    }
  };


  const run = async (task: () => Promise<AuthSettings>, success: string) => {
    setSaving(true);
    try {
      const next = await task();
      setSettings(next);
      setPersistedSettings(next);
      onAuthSettingsChange?.(next);
      setId("");
      setPassword("");
      setTotpSecret("");
      setMfaEnabled(next.mfaEnabled);
      setMfaConsent(next.mfaEnabled);
      setEditingCredentials(false);
      setSetupStarted(false);
      try {
        const secrets = await getSavedMfaSecrets();
        setSavedSecrets(secrets.configured && secrets.totpSecret ? {
          totpSecret: secrets.totpSecret,
          temporaryCancelCode: secrets.temporaryCancelCode || "",
        } : null);
      } catch {
        setSavedSecrets(null);
      }
      setStatus(success);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!await requestAuthenticationInfoPermission()) {
      setStatus("自動ログインを使用するには認証情報の利用許可が必要です。Firefoxの許可を確認してください。");
      return;
    }
    await run(
      () => saveAuthSettings({
        enabled: true,
        id,
        password,
        totpSecret,
        mfaConsent,
        mfaEnabled: mfaEnabled && Boolean(hasSavedMfa || totpSecret.trim()),
      }),
      "端末内に暗号化して保存しました。",
    );
  };

  const toggleAutoLogin = async (enabled: boolean) => {
    if (!settings.configured) {
      setSetupStarted(true);
      setSettings({ ...settings, enabled: true });
      setStatus("ログイン情報を保存してから自動ログインを有効にできます。");
      return;
    }
    if (enabled && !await requestAuthenticationInfoPermission()) {
      setStatus("自動ログインを使用するには認証情報の利用許可が必要です。Firefoxの許可を確認してください。");
      return;
    }
    setSettings({ ...settings, enabled });
    void run(
      () => saveAuthSettings({
        enabled,
        id: "",
        password: "",
        totpSecret: "",
        mfaConsent: settings.mfaEnabled,
        mfaEnabled: settings.mfaEnabled,
      }),
      enabled ? "自動ログインを有効にしました。" : "自動ログインを停止しました。",
    );
  };

  const toggleMfa = (enabled: boolean) => {
    setSettings({ ...settings, mfaEnabled: enabled });
    setMfaEnabled(enabled);
    setMfaConsent(enabled);
    if (!enabled) {
      setTotpSecret("");
      void run(
        () => saveAuthSettings({
          enabled: settings.enabled,
          id: "",
          password: "",
          totpSecret: "",
          mfaConsent: settings.mfaEnabled,
          mfaEnabled: false,
        }),
        "二段階認証を停止しました。",
      );
    } else {
      setStatus(hasSavedMfa ? "二段階認証を使用できます。" : "二段階認証情報を登録してください。");
    }
  };

  const saveManualTotp = async () => {
    if (!await requestAuthenticationInfoPermission()) {
      setStatus("MFAを使用するには認証情報の利用許可が必要です。Firefoxの許可を確認してください。");
      return;
    }
    await run(
      () => saveAuthSettings({
        enabled: settings.enabled,
        id: "",
        password: "",
        totpSecret,
        mfaConsent: true,
        mfaEnabled: true,
      }),
      "TOTP シークレットを保存しました。",
    );
  };

  const cancelCredentialEdit = () => {
    setEditingCredentials(false);
    setId("");
    setPassword("");
    setStatus("");
  };

  const copyValue = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setMfaCopyStatus(message);
    } catch {
      setMfaCopyStatus("コピーできませんでした。キーを表示して手動でコピーしてください。");
    }
  };

  const confirmDelete = () => {
    setShowDeleteModal(true);
  };

  const removeSavedCredentials = () => {
    setShowDeleteModal(false);
    void run(async () => {
      const next = await deleteAuthSettings();
      setId("");
      setPassword("");
      setTotpSecret("");
      setMfaConsent(false);
      setMfaEnabled(false);
      setEditingCredentials(false);
      setSetupStarted(false);
      setSetupStep(1);
      return next;
    }, "保存済みの認証情報を削除しました。");
  };

  const confirmMfaDelete = () => {
    setShowMfaDeleteModal(true);
  };

  const removeSavedMfa = () => {
    setShowMfaDeleteModal(false);
    void run(async () => {
      const next = await deleteMfaSettings();
      setTotpSecret("");
      setMfaConsent(false);
      setMfaEnabled(false);
      return next;
    }, "保存済みの二段階認証情報を削除しました。");
  };

  return (
    <div className="settings-page">
      <div className="settings-container">
        {/* 左カラム：操作系 */}
        <div className="settings-main">
          {!settings.configured ? (
            <section className="section settings-card setup-card">
              {!setupStarted ? (
                <>
                  <div className="section-heading">
                    <div>
                      <h2>自動ログインを設定する</h2>
                      <p>まだ自動ログインは設定されていません。利用するには、この端末にログイン情報を保存してください。</p>
                    </div>
                  </div>
                  <button className="primary-action" onClick={() => setSetupStarted(true)} type="button">
                    自動ログインを設定する
                  </button>
                </>
              ) : (
                <>
                  <div className="wizard-steps" aria-label="初回設定の進行状況">
                    {["ログイン情報", "二段階認証", "確認"].map((label, index) => (
                      <span
                        aria-current={setupStep === index + 1 ? "step" : undefined}
                        className={setupStep === index + 1 ? "active" : ""}
                        key={label}
                      >
                        {index + 1}. {label}
                      </span>
                    ))}
                  </div>

                  {setupStep === 1 && (
                    <form
                      className="settings-form-block"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (setupCanGoNext) setSetupStep(2);
                      }}
                    >
                      <div className="section-heading compact">
                        <div>
                          <h2>ログイン情報</h2>
                          <p>大阪大学個人IDとパスワードを、この端末内に保存します。</p>
                        </div>
                      </div>
                      <div className="settings-grid">
                        <label>
                          <span>大阪大学個人ID</span>
                          <input autoComplete="username" onChange={(event) => setId(event.target.value)} value={id} />
                        </label>
                        <label>
                          <span>パスワード</span>
                          <input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
                        </label>
                      </div>
                      <div className="settings-actions">
                        <button className="primary-action" disabled={!setupCanGoNext} type="submit">
                          次へ
                        </button>
                        <button className="secondary-action" onClick={() => setSetupStarted(false)} type="button">
                          キャンセル
                        </button>
                      </div>
                    </form>
                  )}

                  {setupStep === 2 && (
                    <div className="settings-form-block">
                      <div className="section-heading compact">
                        <div>
                          <h2>二段階認証</h2>
                          <p>この端末で6桁の認証コードを生成する場合だけ登録します。</p>
                        </div>
                      </div>
                      <label className="mfa-consent">
                        <input checked={mfaEnabled} onChange={(event) => {
                          setMfaEnabled(event.target.checked);
                          setMfaConsent(event.target.checked);
                          if (!event.target.checked) setTotpSecret("");
                        }} type="checkbox" />
                        <span>端末内保存とMFA自動化のリスクを理解し、この端末で利用することに同意します。</span>
                      </label>
                      {mfaEnabled && (
                        <details className="settings-details-accordion setup-details-accordion">
                          <summary>詳細オプション</summary>
                          <div className="manual-totp-panel setup-manual-totp">
                            <label>
                              <span>手動入力用キー</span>
                              <input
                                autoComplete="one-time-code"
                                onChange={(event) => setTotpSecret(event.target.value)}
                                placeholder="例: JBSWY3DPEHPK3PXP"
                                type="password"
                                value={totpSecret}
                              />
                            </label>
                          </div>
                        </details>
                      )}
                      <div className="settings-actions">
                        <button className="secondary-action" disabled={!mfaConsent || saving} onClick={() => {
                          setMfaConsentChecked1(false);
                          setMfaConsentChecked2(false);
                          setMfaWizardStep("consent");
                          setShowMfaWizardModal(true);
                        }} type="button">
                          二段階認証を自動登録する
                        </button>
                        <button className="primary-action" onClick={() => setSetupStep(3)} type="button">
                          {hasSavedMfa ? "確認へ" : "スキップして確認へ"}
                        </button>
                        <button className="secondary-action" onClick={() => setSetupStep(1)} type="button">
                          戻る
                        </button>
                      </div>
                    </div>
                  )}

                  {setupStep === 3 && (
                    <div className="settings-form-block">
                      <div className="section-heading compact">
                        <div>
                          <h2>確認</h2>
                          <p>保存すると、自動ログインが有効になります。</p>
                        </div>
                      </div>
                      <dl className="settings-state-list">
                        <div>
                          <dt>大阪大学個人ID</dt>
                          <dd>{id ? `${id.slice(0, 2)}${"*".repeat(Math.max(2, id.length - 4))}${id.slice(-2)}` : "未入力"}</dd>
                        </div>
                        <div>
                          <dt>パスワード</dt>
                          <dd>{password ? "保存予定" : "未入力"}</dd>
                        </div>
                        <div>
                          <dt>二段階認証</dt>
                          <dd>{hasSavedMfa ? "登録済み" : "未登録"}</dd>
                        </div>
                      </dl>
                      <div className="settings-actions">
                        <button className="primary-action" disabled={!canFinishSetup} onClick={save} type="button">
                          {saving ? "保存中..." : "保存して有効化"}
                        </button>
                        <button className="secondary-action" onClick={() => setSetupStep(2)} type="button">
                          戻る
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          ) : (
            <>
              {/* 自動ログインセクション */}
              <section className="section settings-card">
                <label className="section-heading toggle-heading">
                  <div>
                    <div className="setting-title"><h2>自動ログイン</h2><span className="setting-state">{settings.enabled ? "有効" : "無効"}</span></div>
                    <p>保存したログイン情報を使い、画面を開いている間に自動同期します。</p>
                  </div>
                  <div className="switch">
                    <input
                      aria-label="自動ログインを有効にする"
                      checked={settings.enabled}
                      disabled={saving}
                      onChange={(event) => toggleAutoLogin(event.target.checked)}
                      type="checkbox"
                    />
                    <span className="slider"></span>
                  </div>
                </label>

                <div className="settings-toggle-details">
                  <hr className="settings-divider" />
                  {!editingCredentials ? (
                    <div className="saved-id-row">
                      <span className="setting-state">ログイン情報：保存済み</span>
                      <button className="secondary-action" onClick={() => setEditingCredentials(true)} type="button">
                        ログイン情報を変更
                      </button>
                    </div>
                  ) : (
                    <form
                      className="settings-form-block"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (canSaveCredentials) void save();
                      }}
                    >
                      <div className="settings-grid">
                        <label>
                          <span>大阪大学個人ID</span>
                          <input
                            autoComplete="username"
                            onChange={(event) => setId(event.target.value)}
                            placeholder={settings.configured ? `保存済み: ${settings.idHint}` : ""}
                            value={id}
                          />
                        </label>
                        <label>
                          <span>パスワード</span>
                          <input
                            autoComplete="current-password"
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder={settings.configured ? "保存済み（変更時のみ入力）" : ""}
                            type="password"
                            value={password}
                          />
                        </label>
                      </div>
                      <div className="settings-actions-row">
                        <div className="settings-actions">
                          <button className="primary-action" disabled={!canSaveCredentials} type="submit">
                            {saving ? "保存中..." : "保存"}
                          </button>
                          <button className="secondary-action" onClick={cancelCredentialEdit} type="button">
                            キャンセル
                          </button>
                        </div>
                        <button className="danger-text-action" disabled={saving} onClick={confirmDelete} type="button">
                          認証情報を削除
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              </section>

              {/* 二段階認証セクション */}
              <section className="section settings-card">
                <label className="section-heading toggle-heading">
                  <div>
                    <div className="setting-title"><h2>二段階認証</h2><span className="setting-state">{settings.mfaEnabled ? (hasSavedMfa ? "有効・登録済み" : "未登録") : (hasSavedMfa ? "無効・登録済み" : "無効・未登録")}</span></div>
                    <p>ログインに使う6桁コードをこの端末で生成します。</p>
                  </div>
                  <div className="switch">
                    <input
                      aria-label="二段階認証を有効にする"
                      checked={settings.mfaEnabled}
                      disabled={saving}
                      onChange={(event) => toggleMfa(event.target.checked)}
                      type="checkbox"
                    />
                    <span className="slider"></span>
                  </div>
                </label>

                {settings.mfaEnabled && <div className="settings-toggle-details">
                  <hr className="settings-divider" />
                  
                  {!hasSavedMfa && (
                    <div className="mfa-status-info unconfigured">
                      <span className="mfa-badge disabled">未登録</span>
                      <p className="mfa-status-desc">自動ログインで二段階認証を通過させるには、MFA情報の登録が必要です。</p>
                    </div>
                  )}

                  <div className="settings-actions-row">
                    <div className="settings-actions">
                      <button className={hasSavedMfa ? "secondary-action" : "primary-action"} disabled={saving || !settings.mfaEnabled} onClick={() => {
                        setMfaConsentChecked1(false);
                        setMfaConsentChecked2(false);
                        setMfaWizardStep("consent");
                        setShowMfaWizardModal(true);
                      }} type="button">
                        {hasSavedMfa ? "再設定" : "二段階認証を自動登録する"}
                      </button>
                      {hasSavedMfa && (
                        <button className="secondary-action" onClick={() => {
                          setMfaWizardStep("qr");
                          setShowMfaWizardModal(true);
                        }} type="button">
                          登録情報・QRコードを表示
                        </button>
                      )}
                    </div>
                    {hasSavedMfa && (
                      <button className="danger-text-action" disabled={saving} onClick={confirmMfaDelete} type="button">
                        登録情報を削除
                      </button>
                    )}
                  </div>

                  <details className="settings-details-accordion">
                    <summary>詳細オプション</summary>
                    <div className="manual-totp-panel">
                      <label>
                        <span>手動入力用キー</span>
                        <input
                          autoComplete="one-time-code"
                          onChange={(event) => setTotpSecret(event.target.value)}
                          placeholder={hasSavedMfa ? "登録済み（変更時のみ入力）" : "例: JBSWY3DPEHPK3PXP"}
                          type="password"
                          value={totpSecret}
                        />
                      </label>
                      <button className="secondary-action" disabled={!canSaveManualTotp} onClick={saveManualTotp} type="button">
                        手動入力で保存
                      </button>
                    </div>
                  </details>
                </div>}
              </section>
            </>
          )}
          <details className="section settings-card storage-management-card">
            <summary className="storage-management-summary"><h2>データ管理</h2><span>キャッシュ・バックアップ</span></summary>
            <div className="storage-management-body">
              <dl className="storage-usage-summary">
                <div>
                  <dt>管理対象の使用量</dt>
                  <dd>{formatStorageBytes(managedStorageBytes)}</dd>
                </div>
                <div>
                  <dt>全体の使用量</dt>
                  <dd>{storageUsage.ok ? formatStorageBytes(storageUsage.totalUtf8Bytes) : "確認できません"}</dd>
                </div>
              </dl>
              {!storageUsage.ok && (
                <p className="storage-management-error" role="alert">
                  保存領域を確認できません。{storageUsage.error?.message || "ブラウザの設定を確認してください。"}
                </p>
              )}
              <p className="storage-management-note">
                書き出しにはKOAN/CLEのキャッシュだけが含まれ、認証情報・テーマ・同意情報は含まれません。キャッシュ削除後もそれらは保持されます。
              </p>
              <div className="storage-management-actions">
                <button className="secondary-action" disabled={!storageUsage.ok} onClick={exportCache} type="button">
                  キャッシュを書き出す
                </button>
                <button className="danger-text-action" disabled={cacheClearing} onClick={() => setShowCacheDeleteModal(true)} type="button">
                  キャッシュを削除
                </button>
              </div>
              <button className="subtle-action storage-refresh-action" onClick={refreshStorageUsage} type="button">
                使用量を再確認
              </button>
            </div>
          </details>
          {status && (
            <p className="settings-status" aria-live="polite" role="status">
              {status}
            </p>
          )}
        </div>

        {/* 右カラム：必要なときに確認する補足 */}
        <div className="settings-sidebar">
          <section className="section settings-card how-it-works-card">
            <div className="section-heading">
              <div>
                <h2>認証情報の扱い</h2>
              </div>
            </div>
            <p className="settings-privacy-summary">認証情報はこの端末内に保存します。</p>
            <details className="settings-details-accordion credential-details">
              <summary>保存と利用について</summary>
              <div className="credential-safety-body">
              <dl className="credential-safety-list">
                <div>
                  <dt>保存場所</dt>
                  <dd>個人ID・パスワード・二段階認証情報は、この端末内だけに保存します。</dd>
                </div>
                <div>
                  <dt>使用範囲</dt>
                  <dd>阪大のログイン画面への入力と、6桁認証コードの生成にのみ使用します。</dd>
                </div>
                <div>
                  <dt>利用する端末</dt>
                  <dd>自分だけが管理する端末で利用し、共用端末では登録しないでください。</dd>
                </div>
              </dl>
              <p className="credential-safety-note">
                端末を譲渡・廃棄するときは、先に登録情報を削除してください。
              </p>
              </div>
            </details>
          </section>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <Modal labelledBy="delete-credentials-title" onDismiss={() => setShowDeleteModal(false)}>
          <h3 className="modal-title" id="delete-credentials-title">認証情報を削除しますか</h3>
          <p className="modal-text">次の情報をこの端末から削除します。この操作は取り消せません。</p>
          <ul className="modal-delete-list">
            <li>大阪大学個人ID</li>
            <li>パスワード</li>
          </ul>
          <p className="modal-note">※登録済みの二段階認証情報は維持されます。</p>
          <div className="modal-actions">
            <button className="modal-btn cancel" onClick={() => setShowDeleteModal(false)} type="button">
              キャンセル
            </button>
            <button className="modal-btn confirm" onClick={removeSavedCredentials} type="button">
              削除する
            </button>
          </div>
        </Modal>
      )}

      {/* MFA Delete Confirmation Modal */}
      {showMfaDeleteModal && (
        <Modal labelledBy="delete-mfa-title" onDismiss={() => setShowMfaDeleteModal(false)}>
          <h3 className="modal-title" id="delete-mfa-title">二段階認証情報を削除しますか</h3>
          <p className="modal-text">登録されている二段階認証情報（手動入力キー、一時解除コード）をこの端末から削除します。この操作は取り消せません。</p>
          <div className="modal-actions">
            <button className="modal-btn cancel" onClick={() => setShowMfaDeleteModal(false)} type="button">
              キャンセル
            </button>
            <button className="modal-btn confirm" onClick={removeSavedMfa} type="button">
              削除する
            </button>
          </div>
        </Modal>
      )}

      {showCacheDeleteModal && (
        <Modal labelledBy="delete-cache-title" onDismiss={() => setShowCacheDeleteModal(false)}>
          <h3 className="modal-title" id="delete-cache-title">キャッシュを削除して再読み込みしますか</h3>
          <p className="modal-text">
            KOAN/CLEの取得データ、成績、資料一覧、更新履歴をこの端末から削除し、画面を再読み込みします。必要なデータは次回更新時に再取得できます。
          </p>
          <p className="modal-note">認証情報・二段階認証情報・テーマ・利用規約への同意は削除されません。</p>
          <div className="modal-actions">
            <button className="modal-btn cancel" onClick={() => setShowCacheDeleteModal(false)} type="button">
              キャンセル
            </button>
            <button className="modal-btn confirm" disabled={cacheClearing} onClick={clearCache} type="button">
              {cacheClearing ? "削除中…" : "削除して再読み込み"}
            </button>
          </div>
        </Modal>
      )}

      {/* MFA Wizard Modal */}
      {showMfaWizardModal && (mfaWizardStep !== "qr" || Boolean(savedSecrets?.totpSecret)) && (
        <Modal
          className="mfa-wizard-modal"
          labelledBy={`mfa-wizard-title-${mfaWizardStep}`}
          onDismiss={mfaWizardStep === "registering" && !mfaRegistrationTimedOut ? undefined : closeMfaWizard}
          overlayClassName="mfa-wizard-overlay"
        >
            <div className="mfa-wizard-viewport">
              <div className={`mfa-wizard-track step-${mfaWizardStep}`}>
                
                {/* Step 1: Consent */}
                <div className="mfa-wizard-slide mfa-consent-slide">
                  <header className="mfa-consent-header">
                    <h3 className="modal-title" id="mfa-wizard-title-consent" tabIndex={-1}>二段階認証を自動登録します</h3>
                    <p>始める前に、認証アプリの再設定と端末内保存について確認してください。</p>
                  </header>

                  <div className="mfa-consent-body">
                    <div className="consent-notice">
                      <span className="consent-notice-number">1</span>
                      <div>
                        <h4>現在の認証コードは使えなくなります</h4>
                        <p>登録すると、現在スマホ等で使っている認証アプリの設定が更新されます。</p>
                        <p>登録完了後に表示されるQRコードを、認証アプリでもう一度読み込んでください。</p>
                      </div>
                    </div>

                    <div className="consent-notice">
                      <span className="consent-notice-number">2</span>
                      <div>
                        <h4>認証情報をこの端末に保存します</h4>
                        <p>認証情報は外部サーバーへ送信せず、この端末内だけに保存します。</p>
                        <p>紛失時の不正利用を防ぐため、共用端末や他人が使う端末では登録しないでください。</p>
                      </div>
                    </div>

                    <div className="consent-checkboxes">
                      <label className="consent-checkbox-label">
                        <input
                          type="checkbox"
                          checked={mfaConsentChecked1}
                          onChange={(e) => setMfaConsentChecked1(e.target.checked)}
                        />
                        <span>認証アプリの再登録が必要であることを理解しました</span>
                      </label>
                      <label className="consent-checkbox-label">
                        <input
                          type="checkbox"
                          checked={mfaConsentChecked2}
                          onChange={(e) => setMfaConsentChecked2(e.target.checked)}
                        />
                        <span>端末内保存のリスクを理解しました</span>
                      </label>
                    </div>
                  </div>

                  <footer className="modal-actions mfa-consent-footer">
                    <button className="modal-btn cancel" onClick={closeMfaWizard} type="button">
                      キャンセル
                    </button>
                    <button
                      className="modal-btn primary"
                      disabled={!mfaConsentChecked1 || !mfaConsentChecked2}
                      onClick={handleStartRegister}
                      type="button"
                    >
                      登録を開始
                    </button>
                  </footer>
                </div>

                {/* Step 2: Registering (Loading) */}
                <div className="mfa-wizard-slide">
                  <div className="mfa-wizard-loading-content" role="status" aria-live="polite">
                    <div className="spinner-wrapper">
                      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide-icon spinner">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                      </svg>
                    </div>
                    <h3 className="modal-title loading-title" id="mfa-wizard-title-registering" tabIndex={-1}>二段階認証情報を自動登録中</h3>
                    <p className="modal-text loading-text">
                      ブラウザのバックグラウンドタブで設定を実行しています。<br />
                      {mfaRegistrationTimedOut
                        ? "処理が長引いています。前面のタブを確認するか、閉じて後で再試行してください。"
                        : "MFA登録情報の取得を完了するまで、このまま数秒お待ちください。"}
                    </p>
                    {mfaRegistrationTimedOut && (
                      <button className="modal-btn cancel" onClick={closeMfaWizard} type="button">
                        閉じて再試行
                      </button>
                    )}
                  </div>
                </div>

                {/* Step 3: QR Code & Secrets */}
                <div className="mfa-wizard-slide step-qr-slide">
                  <h3 className="modal-title" id="mfa-wizard-title-qr" tabIndex={-1}>登録情報・QRコード</h3>
                  <p className="modal-text qr-instruction-text">
                    認証アプリでQRコードを読み込めます。手動登録には右のキーを使ってください。
                  </p>
                  <div className="mfa-qr-layout-container">
                    <div className="mfa-qr-left-col">
                      <div className="qr-box">
                        <canvas
                          aria-label="二段階認証登録用QRコード。読み取れない場合は手動入力用キーを使用してください。"
                          role="img"
                          ref={qrCanvasRef}
                        />
                      </div>
                    </div>
                    <div className="mfa-qr-right-col">
                      <div className="mfa-secret-panel modal-secret-panel">
                        <div className="secret-row">
                          <span className="secret-label">手動入力用キー</span>
                          <code className="secret-code">{showMfaSecret ? savedSecrets?.totpSecret : maskedTotpSecret}</code>
                          <div className="secret-actions">
                            <button
                              aria-label={showMfaSecret ? "手動入力用キーを隠す" : "手動入力用キーを表示"}
                              className="icon-action"
                              onClick={() => setShowMfaSecret(!showMfaSecret)}
                              title={showMfaSecret ? "隠す" : "表示"}
                              type="button"
                            >
                              {showMfaSecret ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide-icon">
                                  <path d="m15 18-.722-3.25"/>
                                  <path d="M2 8a10.645 10.645 0 0 0 20 0"/>
                                  <path d="m20 15-1.726-2.05"/>
                                  <path d="m4 15 1.726-2.05"/>
                                  <path d="m9 18 .722-3.25"/>
                                </svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide-icon">
                                  <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
                                  <circle cx="12" cy="12" r="3"/>
                                </svg>
                              )}
                            </button>
                            <button aria-label="手動入力用キーをコピー" className="subtle-action" disabled={!savedSecrets?.totpSecret} onClick={() => savedSecrets?.totpSecret && void copyValue(savedSecrets.totpSecret, "手動入力用キーをコピーしました。")} type="button">
                              コピー
                            </button>
                          </div>
                        </div>

                        {savedSecrets?.temporaryCancelCode && (
                          <div className="secret-row">
                            <span className="secret-label">一時解除コード</span>
                            <code className="secret-code">{showCancelCode ? savedSecrets.temporaryCancelCode : maskedCancelCode}</code>
                            <div className="secret-actions">
                              <button
                                aria-label={showCancelCode ? "一時解除コードを隠す" : "一時解除コードを表示"}
                                className="icon-action"
                                onClick={() => setShowCancelCode(!showCancelCode)}
                                title={showCancelCode ? "隠す" : "表示"}
                                type="button"
                              >
                                {showCancelCode ? (
                                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide-icon">
                                    <path d="m15 18-.722-3.25"/>
                                    <path d="M2 8a10.645 10.645 0 0 0 20 0"/>
                                    <path d="m20 15-1.726-2.05"/>
                                    <path d="m4 15 1.726-2.05"/>
                                    <path d="m9 18 .722-3.25"/>
                                  </svg>
                                ) : (
                                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide-icon">
                                    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
                                    <circle cx="12" cy="12" r="3"/>
                                  </svg>
                                )}
                              </button>
                              <button aria-label="一時解除コードをコピー" className="subtle-action" onClick={() => void copyValue(savedSecrets.temporaryCancelCode, "一時解除コードをコピーしました。")} type="button">
                                コピー
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="modal-actions qr-actions">
                    <p className="mfa-copy-status" role="status" aria-live="polite">{mfaCopyStatus}</p>
                    <button
                      className="modal-btn cancel"
                      onClick={closeMfaWizard}
                      type="button"
                    >
                      閉じる
                    </button>
                  </div>
                </div>

              </div>
            </div>
        </Modal>
      )}
    </div>

  );
}

function fmtDue(value: string | null) {
  if (!value) return "期限なし";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function dueLabel(value: string | null) {
  if (!value) return "期限なし";
  const milliseconds = new Date(value).getTime() - Date.now();
  const hours = Math.ceil(milliseconds / (60 * 60 * 1000));
  if (hours < 0) return "期限超過";
  if (hours <= 24) return hours <= 1 ? "まもなく" : `あと${hours}時間`;
  return `あと${Math.ceil(hours / 24)}日`;
}

function taskLabel(task: CleTask) {
  const status = taskDisplayStatus(task);
  if (status === "採点済み" && task.score !== undefined) {
    return task.possibleScore !== undefined
      ? `${task.score}/${task.possibleScore}`
      : `${task.score}点`;
  }
  if (["提出済み", "採点済み", "期限切れ"].includes(status)) {
    return status;
  }
  return dueLabel(task.dueAt);
}

function taskDisplayStatus(task: CleTask): CleTask["status"] {
  if (["提出済み", "採点済み"].includes(task.status)) return task.status;
  if (task.status === "期限切れ" || (task.dueAt && new Date(task.dueAt).getTime() < Date.now())) {
    return "期限切れ";
  }
  return task.status;
}

function taskDueDescription(task: CleTask) {
  return task.dueAt ? `${fmtDue(task.dueAt)}まで` : "期限なし";
}

function compareTaskDueAt(left: CleTask, right: CleTask) {
  if (!left.dueAt && !right.dueAt) return left.title.localeCompare(right.title, "ja");
  if (!left.dueAt) return 1;
  if (!right.dueAt) return -1;
  return left.dueAt.localeCompare(right.dueAt);
}

function taskTone(task: CleTask) {
  const status = taskDisplayStatus(task);
  if (["提出済み", "採点済み"].includes(status)) return "done";
  if (status === "期限切れ") return "attention";
  return "neutral";
}

function courseDisplayName(value: string) {
  const withoutCode = value.replace(/^[^:]+:\s*\d+\s*/, "");
  const japanese = withoutCode.split(/\s*\/\s*/)[0];
  return japanese
    .replace(/\s*【[^】]*】/g, "")
    .replace(/\s+[月火水木金土日]\d+\s*$/, "")
    .trim() || value;
}

function normalizeCourseTitle(value: string) {
  return courseDisplayName(value)
    .replace(/^【取消】/, "")
    .replace(/\s*【[^】]*】/g, "")
    .replace(/[ 　]+/g, "")
    .toLowerCase();
}

function timetableCodeFromCleDisplay(value: string) {
  return value.match(/^\d{4}-\d{2}-(\d{6})-/)?.[1] || "";
}

type CourseSummary = {
  code: string;
  koan: CourseRegistration;
  cleCourse?: CleCourse;
  tasks: CleTask[];
  messages: CleData["messages"];
  announcements: CleAnnouncement[];
  notices: Notice[];
  changes: ChangeItem[];
  schedules: ScheduleItem[];
};

function courseMatchesText(course: CourseRegistration, value: string) {
  const courseTitle = normalizeCourseTitle(course.title);
  const text = normalizeCourseTitle(value);
  return Boolean(courseTitle && text && (text.includes(courseTitle) || courseTitle.includes(text)));
}

function buildCourseSummaries(data: KoanData, cleData: CleData): CourseSummary[] {
  const cleByCode = new Map<string, CleCourse>();
  const cleCodeByCourseId = new Map<string, string>();
  for (const course of cleData.courses || []) {
    const code = course.timetableCode || timetableCodeFromCleDisplay(course.displayId);
    if (!code) continue;
    cleByCode.set(code, course);
    cleCodeByCourseId.set(course.courseId, code);
  }
  return (data.courses || []).filter((course) => !/【取消】|取消/.test(course.title)).map((course) => {
    let cleCourse = cleByCode.get(course.code);
    if (cleCourse) {
      const hasAvailableAlternative = (cleData.courses || []).find(
        (c) => c.courseId !== cleCourse!.courseId && c.available === true && courseMatchesText(course, c.name)
      );
      if (hasAvailableAlternative && cleCourse.available !== true) {
        cleCourse = hasAvailableAlternative;
      }
    } else {
      const alternative = (cleData.courses || []).find(
        (c) => c.available !== false && courseMatchesText(course, c.name)
      );
      if (alternative) cleCourse = alternative;
    }
    const tasks = cleData.tasks.filter((task) => {
      if (cleCourse && task.courseId === cleCourse.courseId) return true;
      const code = cleCodeByCourseId.get(task.courseId) || timetableCodeFromCleDisplay(task.courseName);
      return code ? code === course.code : courseMatchesText(course, task.courseName);
    });
    const messages = cleData.messages.filter((message) => {
      if (cleCourse && message.courseId === cleCourse.courseId) return true;
      const code = cleCodeByCourseId.get(message.courseId) || timetableCodeFromCleDisplay(message.courseName);
      return code ? code === course.code : courseMatchesText(course, message.courseName);
    });
    const announcements = (cleData.announcements || []).filter((ann) => {
      if (cleCourse && ann.courseId === cleCourse.courseId) return true;
      const code = cleCodeByCourseId.get(ann.courseId) || timetableCodeFromCleDisplay(ann.courseName);
      return code ? code === course.code : courseMatchesText(course, ann.courseName);
    });
    const schedules = data.schedule.filter((item) => courseMatchesText(course, item.title));
    const changes = data.changes.filter((item) => courseMatchesText(course, item.course));
    const notices = data.notices
      .filter((notice) => courseMatchesText(course, notice.title))
      .sort((left, right) => attentionScore(right) - attentionScore(left));
    return {
      code: course.code,
      koan: course,
      cleCourse,
      tasks: tasks.sort((left, right) => {
        const getTaskPriority = (task: CleTask) => {
          const status = taskDisplayStatus(task);
          const isDone = ["提出済み", "採点済み"].includes(status);
          if (isDone) return 3;
          const isOverdue = status === "期限切れ";
          if (isOverdue) return 2;
          return 1;
        };
        const leftPriority = getTaskPriority(left);
        const rightPriority = getTaskPriority(right);
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return compareTaskDueAt(left, right);
      }),
      messages,
      announcements: announcements.sort((left, right) => right.created.localeCompare(left.created)),
      notices,
      changes,
      schedules,
    };
  });
}

const timetableDays = ["月", "火", "水", "木", "金", "土"] as const;
const timetablePeriods = ["1", "2", "3", "4", "5", "6"];

function courseSlots(course: CourseRegistration) {
  const slotPattern = /([月火水木金土日])\s*(\d+)/g;
  const slots = [...course.period.matchAll(slotPattern)]
    .map((match) => ({ day: match[1], period: match[2] }));
  if (slots.length) return slots;
  const period = periodNumber(course.period);
  return course.day && period ? [{ day: course.day, period }] : [];
}

function courseSlotLabel(course: CourseRegistration) {
  const slots = courseSlots(course);
  if (slots.length) return slots.map((slot) => `${slot.day}${slot.period}`).join(",");
  return [course.day, course.period].filter(Boolean).join(" ");
}

function courseTeacherRoom(value: string) {
  const normalized = value.replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
  if (!normalized) return { teacher: "未取得", room: "未取得" };
  const slashParts = normalized.split(" / ").map((part) => part.trim()).filter(Boolean);
  if (slashParts.length >= 2) {
    return { teacher: slashParts[0], room: slashParts.slice(1).join(" / ") };
  }
  const roomKeyword = /(法経|講義室|教室|研究室|演習室|セミナー室|レバレジーズ|オンライン|未定|豊中|吹田|箕面)/;
  const keywordIndex = normalized.search(roomKeyword);
  if (keywordIndex > 0) {
    return {
      teacher: normalized.slice(0, keywordIndex).trim(),
      room: normalized.slice(keywordIndex).trim(),
    };
  }
  return { teacher: normalized, room: "未取得" };
}

function courseTermHeading(courses: CourseSummary[]) {
  const year = courses.find((course) => course.koan.year)?.koan.year || String(new Date().getFullYear());
  const month = new Date().getMonth() + 1;
  const term = month >= 10 || month <= 3 ? "秋・冬学期" : "春・夏学期";
  return `${year}年 ${term}`;
}

type EmptyStateIconName =
  | "calendar"
  | "book-open"
  | "check-circle"
  | "message-square"
  | "info"
  | "sparkles"
  | "mail-open"
  | "inbox"
  | "calendar-check"
  | "search"
  | "graduation-cap"
  | "spinner";

function EmptyStateIcon({ name }: { name: EmptyStateIconName }) {
  const attrs = {
    xmlns: "http://www.w3.org/2000/svg",
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: `lucide-icon ${name === "spinner" ? "spinner" : ""}`,
  } as const;

  switch (name) {
    case "calendar":
      return (
        <svg {...attrs}>
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <path d="M3 10h18" />
        </svg>
      );
    case "book-open":
      return (
        <svg {...attrs}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
      );
    case "check-circle":
      return (
        <svg {...attrs}>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "message-square":
      return (
        <svg {...attrs}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "info":
      return (
        <svg {...attrs}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...attrs}>
          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275Z" />
          <path d="m5 3 1 2.5L8.5 6 6 7 5 9.5 4 7 1.5 6 4 5Z" />
          <path d="m19 17 1 2.5 2.5.5-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z" />
        </svg>
      );
    case "mail-open":
      return (
        <svg {...attrs}>
          <path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z" />
          <path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" />
        </svg>
      );
    case "inbox":
      return (
        <svg {...attrs}>
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
      );
    case "calendar-check":
      return (
        <svg {...attrs}>
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <path d="M3 10h18" />
          <path d="m9 16 2 2 4-4" />
        </svg>
      );
    case "search":
      return (
        <svg {...attrs}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "graduation-cap":
      return (
        <svg {...attrs}>
          <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
          <path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5" />
          <path d="M21.5 12v6" />
        </svg>
      );
    case "spinner":
      return (
        <svg {...attrs}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      );
    default:
      return null;
  }
}

function EmptyState({
  icon,
  title,
  description,
  variant = "normal",
  className = "",
  action,
  headingLevel = 3,
}: {
  icon: EmptyStateIconName;
  title: string;
  description?: string;
  variant?: "normal" | "subtle" | "rail" | "dashboard";
  className?: string;
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
}) {
  const TitleTag = headingLevel === 2 ? "h2" : headingLevel === 4 ? "h4" : "h3";
  if (icon === "spinner") return (
    <div className={`loading-placeholder ${variant} ${className}`} role="status" aria-live="polite">
      <TitleTag className="empty-state-title">{title}</TitleTag>
      <p className="empty-state-desc">{description || "画面を切り替えても取得は続きます。"}</p>
      <div className="skeleton-list" aria-hidden="true">
        {[0, 1, 2].map((row) => <div className="skeleton-row" key={row}><i /><div><i /><i /></div></div>)}
      </div>
    </div>
  );
  return (
    <div className={`empty-state ${variant} ${className}`}>
      <div className="empty-state-icon" aria-hidden="true">
        <EmptyStateIcon name={icon} />
      </div>
      <div className="empty-state-content">
        <TitleTag className="empty-state-title">{title}</TitleTag>
        {description && <p className="empty-state-desc">{description}</p>}
        {action && <div className="empty-state-action">{action}</div>}
      </div>
    </div>
  );
}

function SourceStatus({
  source,
  status,
  updatedAt,
  loaded,
  loading,
  error,
  stale = false,
  onRetry,
}: {
  source: string;
  status: string;
  updatedAt: string | null;
  loaded: boolean;
  loading: boolean;
  error: boolean;
  stale?: boolean;
  onRetry?: () => void;
}) {
  const partial = isPartialStatus(status);
  const state = loading
    ? "loading"
    : error
      ? "error"
      : partial
        ? "partial"
        : !loaded
          ? "idle"
          : stale
            ? "stale"
            : "fresh";
  const message = loading
    ? loaded ? "保存済みを表示中 · 最新情報を確認しています" : "初回のデータを取得しています"
    : error
      ? status || "取得に失敗しました"
      : partial
        ? status
        : !loaded
          ? "未取得"
          : stale
            ? `保存済み / 最終成功 ${fmtTime(updatedAt)}`
            : `最終成功 ${fmtTime(updatedAt)}`;
  return (
    <div className={`source-status source-status-${state}`}>
      <span className="source-status-name">{source}</span>
      <span className="source-status-message" role={error ? "alert" : "status"}>{message}</span>
      {(error || partial || !loaded) && onRetry && (
        <button type="button" onClick={onRetry} disabled={loading}>
          {error || partial ? "再試行" : "取得"}
        </button>
      )}
    </div>
  );
}

function CoursesPage({
  cleData,
  data,
  loading,
  status,
  loaded,
  error,
  onOpenNotice,
  selectedCode,
  onSelectCode,
  onOpenAnnouncement,
  onOpenMaterials,
  materialsPanel,
  materialsBusy,
}: {
  cleData: CleData;
  data: KoanData;
  loading: boolean;
  status: string;
  loaded: boolean;
  error?: boolean;
  onOpenNotice: (notice: Notice) => void;
  selectedCode: string;
  onSelectCode: (code: string) => void;
  onOpenAnnouncement: (ann: CleAnnouncement) => void;
  onOpenMaterials: (course: CourseSummary) => void;
  materialsPanel: ReactNode;
  materialsBusy: boolean;
}) {
  const partial = !error && isPartialStatus(status);
  const courses = useMemo(() => buildCourseSummaries(data, cleData), [cleData, data]);
  useEffect(() => {
    if (selectedCode && !courses.some((course) => course.code === selectedCode)) {
      onSelectCode("");
    }
  }, [courses, selectedCode, onSelectCode]);
  const selected = courses.find((course) => course.code === selectedCode);
  const regularCourses = courses.filter((course) => !course.koan.isIntensive && courseSlots(course.koan).some((slot) =>
    timetableDays.includes(slot.day as typeof timetableDays[number]) &&
    timetablePeriods.includes(slot.period),
  ));
  const irregularCourses = courses.filter((course) => !regularCourses.includes(course));
  return (
    <div className="courses-page">
      <div className="course-timetable-pane">
        {courses.length ? (
          <>
            <div className="course-timetable-heading">
              <h2>{courseTermHeading(courses)}</h2>
            </div>
            <CourseTimetable
              courses={regularCourses}
              onSelect={onSelectCode}
              selectedCode={selectedCode}
            />
            <div className="irregular-courses">
              <h3>集中講義・曜日未定</h3>
              {irregularCourses.length ? (
                <div>
                  {irregularCourses.map((course) => (
                    <button
                      className={course.code === selectedCode ? "active" : ""}
                      key={course.code}
                      onClick={() => onSelectCode(course.code)}
                      type="button"
                    >
                      <span>{course.koan.title}</span>
                      <small>{courseSlotLabel(course.koan) || "曜日時限未定"}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon="book-open"
                  title="該当する授業はありません"
                  variant="subtle"
                />
              )}
            </div>
          </>
        ) : (
          <EmptyState
            icon={loading ? "spinner" : error || partial ? "info" : "calendar"}
            title={loading ? "授業情報を取得しています" : error ? "授業情報を読み込めませんでした" : partial ? "授業情報を一部取得できませんでした" : loaded ? "授業情報がありません" : "まだ取得していません"}
            description={loading ? "画面を切り替えても取得は続きます。" : error || partial ? "ヘッダーの同期の詳細を確認してください。" : loaded ? "現在の期間に表示できる授業はありません。" : "右上の更新ボタンを押すと、KOANとCLEから時間割を読み込みます。"}
            headingLevel={2}
            variant="normal"
          />
        )}
      </div>

      <div className="course-detail-pane">
        {selected ? (
          <CourseDetail
            key={selected.code}
            uncertain={loading || !!error || partial}
            allNotices={data.notices}
            cleData={cleData}
            data={data}
            materialsPanel={materialsPanel}
            materialsBusy={materialsBusy}
            course={selected}
            onOpenNotice={onOpenNotice}
            onOpenAnnouncement={onOpenAnnouncement}
            onOpenMaterials={onOpenMaterials}
          />
        ) : courses.length ? (
          <CourseDefaultDetail />
        ) : null}
      </div>
    </div>
  );
}

function CourseTimetable({
  courses,
  onSelect,
  selectedCode,
}: {
  courses: CourseSummary[];
  onSelect: (code: string) => void;
  selectedCode: string;
}) {
  return (
    <div className="course-timetable" role="table" aria-label="授業時間割">
      <div className="timetable-header" role="row">
        <div className="timetable-corner" role="columnheader" aria-hidden="true"></div>
        {timetableDays.map((day) => <div className="timetable-day" role="columnheader" key={day}>{day}</div>)}
      </div>
      {timetablePeriods.map((period) => (
        <div className="timetable-row" role="row" key={period}>
          <div className="timetable-period" role="rowheader">{period}</div>
          {timetableDays.map((day) => {
            const slotCourses = courses.filter((course) =>
              courseSlots(course.koan).some((slot) => slot.day === day && slot.period === period),
            );
            return (
              <div className="timetable-cell" role="cell" key={`${day}-${period}`}>
                {slotCourses.map((course) => {
                  const activeTasks = course.tasks.filter((task) => {
                    if (["提出済み", "採点済み"].includes(task.status)) return false;
                    if (!task.dueAt) return true;
                    return new Date(task.dueAt).getTime() >= Date.now() - EXPIRED_TASK_VISIBLE_MS;
                  });
                  return (
                    <button
                      className={course.code === selectedCode ? "timetable-course selected" : "timetable-course"}
                      key={course.code}
                      onClick={() => onSelect(course.code)}
                      title={`${course.koan.title}${activeTasks.length ? ` / 未完了課題 ${activeTasks.length}件` : ""}`}
                      type="button"
                    >
                      <b>{course.koan.title}</b>
                      {!!activeTasks.length && (
                        <span
                          aria-label={`未完了課題 ${activeTasks.length}件`}
                          className="timetable-task-indicator"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CourseDefaultDetail() {
  return (
    <div className="course-default-detail" aria-label="授業未選択">
      <EmptyState
        icon="book-open"
        title="授業を選択して詳細を表示"
        description="時間割のコマを選ぶと、課題・連絡・変更情報をここに表示します。"
        variant="normal"
      />
    </div>
  );
}

function CourseDetail({
  allNotices, course, cleData, data, onOpenNotice, onOpenAnnouncement, onOpenMaterials,
  materialsPanel, materialsBusy, uncertain,
}: {
  allNotices: Notice[];
  course: CourseSummary;
  cleData: CleData;
  data: KoanData;
  onOpenNotice: (notice: Notice) => void;
  onOpenAnnouncement: (ann: CleAnnouncement) => void;
  onOpenMaterials: (course: CourseSummary) => void;
  materialsPanel: ReactNode;
  materialsBusy: boolean;
  uncertain: boolean;
}) {
  const teacherRoom = courseTeacherRoom(course.koan.teacherAndRoom);
  const [tab, setTab] = useState<"tasks" | "communications" | "materials">("tasks");
  const panels = useRef<HTMLDivElement>(null);
  const currentChanges = upcomingChanges(course.changes);
  const otherChanges = course.changes.filter((change) => !currentChanges.includes(change));
  const activeTasks = course.tasks.filter((task) => !["提出済み", "採点済み"].includes(task.status));
  const completedTasks = course.tasks.filter((task) => ["提出済み", "採点済み"].includes(task.status));
  const now = Date.now();
  const expired = activeTasks.filter((task) => task.dueAt && Date.parse(task.dueAt) < now);
  const actionable = activeTasks.filter((task) => !expired.includes(task)).sort(compareTaskDueAt);
  const todayTasks = activeTasks.filter((task) => task.dueAt && dateKey(new Date(task.dueAt)) === dateKey(new Date()));
  const items = communicationItems(course.notices, course.announcements, course.messages);
  const unread = items.reduce((sum, item) => sum + item.unreadCount, 0);
  const recent = course.announcements.filter((ann) => isRecentActivity(ann.created)).length;
  const tasksKnown = !!course.cleCourse && !uncertain && !!cleData.tasksUpdatedAt && !cleData.taskStatusPendingCount;
  const communicationsKnown = !!course.cleCourse && !!cleData.announcementsUpdatedAt && !uncertain && !!(data.noticesUpdatedAt || data.snapshotUpdatedAt) && !!cleData.messagesUpdatedAt && cleData.messagesComplete !== false && !cleData.announcementsPendingCount;
  const tabs = [
    { id: "tasks" as const, label: "課題", attention: todayTasks.length ? `今日 ${todayTasks.length}` : "" },
    { id: "communications" as const, label: "連絡・掲示", attention: unread ? `未読 ${unread}` : recent ? `新着 ${recent}` : "" },
    { id: "materials" as const, label: "資料", attention: "" },
  ];
  const selectTab = (next: typeof tab) => {
    setTab(next);
    if (panels.current) panels.current.scrollTop = 0;
    if (next === "materials" && !materialsBusy) onOpenMaterials(course);
  };
  const taskRows = (tasks: CleTask[]) => tasks.map((task) => (
    <AuthenticatedLink className="course-line-row" href={cleTaskUrl(task)} key={task.id} target="_blank">
      <b className={`course-status-label ${taskTone(task)}`}>{taskLabel(task)}</b>
      <span>{task.title}<small>{taskDueDescription(task)} / {taskDisplayStatus(task)}</small></span>
    </AuthenticatedLink>
  ));
  return (
    <div className="course-detail" ref={panels}>
      <div className="course-detail-header">
        <h2>{course.koan.title}</h2>
        <div className="course-detail-meta">
          <div><span>曜日時限</span><b>{courseSlotLabel(course.koan) || "未定"}</b></div>
          <div><span>教室</span><b>{teacherRoom.room}</b></div>
          <div><span>教員</span><b>{teacherRoom.teacher}</b></div>
        </div>
        <div className="course-link-actions">
          {course.cleCourse && <AuthenticatedLink href={cleCourseUrl(course.cleCourse.courseId)} target="_blank">CLEを開く</AuthenticatedLink>}
          {course.koan.syllabusUrl && <AuthenticatedLink href={course.koan.syllabusUrl} target="_blank">シラバス</AuthenticatedLink>}
        </div>
        {!!currentChanges.length && <div className="course-current-changes" aria-label="直近の休講・変更">
          {currentChanges.map((change, i) => <p key={`${change.date}-${change.period}-${i}`}><strong>{change.type}</strong><span>{change.date === "今週" ? "今週（日付未確定）" : change.date} {change.period && `${change.period.replace(/限$/, "")}限`}</span></p>)}
        </div>}
        {!!otherChanges.length && <details className="course-change-history">
          <summary>その他の変更・履歴 {otherChanges.length}件</summary>
          {otherChanges.map((change, i) => <p key={`${change.date}-${change.period}-${i}`}><strong>{change.type}</strong> {change.date || "日付未確認"} {change.period && `${change.period.replace(/限$/, "")}限`}</p>)}
        </details>}
      </div>
      <div className="course-tabs" role="tablist" aria-label="授業情報">
        {tabs.map((item, index) => <button
          key={item.id} id={`course-tab-${item.id}`} role="tab" type="button"
          aria-selected={tab === item.id} aria-controls={`course-panel-${item.id}`}
          tabIndex={tab === item.id ? 0 : -1}
          onClick={() => selectTab(item.id)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = tabs.length - 1;
            else return;
            event.preventDefault();
            selectTab(tabs[next].id);
            document.getElementById(`course-tab-${tabs[next].id}`)?.focus();
          }}
        >{item.label}{item.attention && <small>{item.attention}</small>}</button>)}
      </div>
      <div className="course-tab-content">
        <div role="tabpanel" id="course-panel-tasks" aria-labelledby="course-tab-tasks" hidden={tab !== "tasks"} tabIndex={0}>
        {tab === "tasks" && <>
          {!!course.tasks.length && <p className="task-link-note">CLEの成績・課題一覧で開きます</p>}
          {taskRows(actionable)}
          {!activeTasks.length && <EmptyState icon={tasksKnown ? "check-circle" : "info"} title={tasksKnown ? "提出が必要な課題はありません" : "課題の取得状況は未確認です"} description={tasksKnown ? undefined : "ヘッダーの同期の詳細を確認してください。"} variant="subtle" />}
          {!!expired.length && <details className="expired-tasks"><summary>期限切れ {expired.length}件</summary>{taskRows(expired)}</details>}
          {!!completedTasks.length && <details className="expired-tasks"><summary>提出済み・採点済み {completedTasks.length}件</summary>{taskRows(completedTasks)}</details>}
        </>}
        </div>
        <div role="tabpanel" id="course-panel-communications" aria-labelledby="course-tab-communications" hidden={tab !== "communications"} tabIndex={0}>
        {tab === "communications" && <>
          <CommunicationList items={items} snapshotNotices={allNotices} onOpenNotice={onOpenNotice} onOpenAnnouncement={onOpenAnnouncement} />
          {!items.length && <EmptyState icon={communicationsKnown ? "mail-open" : "info"} title={communicationsKnown ? "連絡・掲示はありません" : "連絡・掲示の取得状況は未確認です"} description={communicationsKnown ? undefined : "ヘッダーの同期の詳細を確認してください。"} variant="subtle" />}
        </>}
        </div>
        <div role="tabpanel" id="course-panel-materials" aria-labelledby="course-tab-materials" hidden={tab !== "materials"} tabIndex={0}>
        {tab === "materials" && (course.cleCourse ? materialsPanel || <div className="materials-idle"><p>{materialsBusy ? "別の授業の資料を保存中です。完了後に取得できます。" : "資料一覧を取得します。"}</p><button type="button" disabled={materialsBusy} onClick={() => onOpenMaterials(course)}>資料を取得</button></div> : <EmptyState icon="info" title="CLEの対応する授業が未確認です" variant="subtle" />)}
        </div>
      </div>
    </div>
  );
}

function CourseMaterialsContent({ list, loading, error, downloadingId, batchProgress, onDownload, onDownloadAll, onRefresh }: {
  list: CleMaterialList | null;
  loading: boolean;
  error: string;
  downloadingId: string;
  batchProgress: string;
  onDownload: (material: CleMaterial) => void;
  onDownloadAll: () => void;
  onRefresh: () => void;
}) {
  const busy = !!(downloadingId || batchProgress);
  return <div className="course-materials">
    <div className="materials-toolbar">
      <small>{list ? `${list.materials.length}件 / 取得 ${fmtTime(list.updatedAt)}` : "この授業の資料だけを取得します"}</small>
      <button type="button" disabled={loading || busy} onClick={onRefresh}>再取得</button>
    </div>
    {loading && <p className="materials-refresh-status" role="status">{list ? "保存済みの一覧を表示しながら更新しています…" : "CLEから資料を読み込んでいます…"}</p>}
    {error && <p className="materials-error" role="alert">{error}</p>}
    {list?.materials.map((material) => <div className="material-row" key={material.id}>
      <div className="material-info"><strong>{material.title}</strong><span>{material.fileName}</span><small>{[material.folderPath.join(" / "), material.addedAt ? `追加 ${fmtTime(material.addedAt)}` : "", formatFileSize(material.size)].filter(Boolean).join(" / ")}</small></div>
      <button type="button" aria-label={materialDownloadLabel(material)} disabled={busy} onClick={() => onDownload(material)}>{downloadingId === material.id ? "取得中…" : "保存"}</button>
    </div>)}
    {!loading && !error && list && !list.materials.length && <EmptyState icon="book-open" title="ダウンロードできる資料はありません" variant="subtle" />}
    {!!list?.materials.length && <div className="materials-batch-actions"><button type="button" aria-label={`${list.materials.length}件の資料をすべてダウンロード`} disabled={loading || busy} onClick={onDownloadAll}>{batchProgress ? `一括取得中 ${batchProgress}` : "すべてダウンロード"}</button></div>}
  </div>;
}

type CollectionState = { name: string; loaded: boolean; loading: boolean; issue: string };

function collectionReady(state: CollectionState) {
  return state.loaded && !state.loading && !state.issue;
}

function CollectionFeedback({ states, onRetry, hasContent = false }: { states: CollectionState[]; onRetry: () => void; hasContent?: boolean }) {
  // The header owns refresh status when cached content is already visible.
  if (hasContent && states.every((state) => state.loaded)) return null;
  const pending = states.filter((state) => !collectionReady(state));
  if (!pending.length) return null;
  const busy = pending.some((state) => state.loading);
  const failed = pending.some((state) => state.issue && !state.loading);
  return (
    <div className="collection-feedback" role="status">
      <div>
        <strong>{pending.map((state) => state.name).join("・")}{busy ? "を確認しています" : failed ? "を確認できていません" : "はまだ取得していません"}</strong>
        <p>{states.some((state) => state.loaded)
          ? busy ? "取得済みの情報を表示しながら更新しています。" : "取得済みの情報を表示しています。最新の状態は確認できていません。"
          : busy ? "完了すると、この場所に表示します。" : "情報を取得して、最新の状態を確認してください。"}</p>
      </div>
      {!busy && <button type="button" onClick={onRetry} aria-label={`${pending.map((state) => state.name).join("・")}${failed ? "を再取得" : "を取得"}`}>
        {failed ? "再試行" : "取得する"}
      </button>}
    </div>
  );
}

function Dashboard({
  cleData,
  cleLoading,
  koanIssue,
  cleIssue,
  onRetry,
  onShowNotices,
  data,
  loading,
  onOpenNotice,
  onSelectCourse,
  onOpenAnnouncement,
}: {
  cleData: CleData;
  cleLoading: boolean;
  koanIssue: string;
  cleIssue: string;
  onRetry: () => void;
  onShowNotices: () => void;
  data: KoanData;
  loading: boolean;
  onOpenNotice: (notice: Notice) => void;
  onSelectCourse: (code: string) => void;
  onOpenAnnouncement: (ann: CleAnnouncement) => void;
}) {
  const [today, setToday] = useState(() => dateKey(new Date()));
  const [selectedDate, setSelectedDate] = useState(today);
  const previousToday = useRef(today);
  useEffect(() => {
    const updateToday = () => setToday(dateKey(new Date()));
    updateToday();
    const interval = window.setInterval(updateToday, 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    if (previousToday.current !== today) {
      const wasToday = previousToday.current;
      previousToday.current = today;
      setSelectedDate((current) => current === wasToday ? today : current);
    }
  }, [today]);
  const selectedSchedule = data.schedule.filter((item) => (item.date || today) === selectedDate);
  const selectedChanges = changesForDate(data.changes, selectedDate, today);
  const koanState = (name: string, timestamp: string | null): CollectionState => ({
    name, loaded: Boolean(timestamp), loading, issue: koanIssue || data.warnings?.join(" / ") || "",
  });
  const cleState = (name: string, timestamp: string | null): CollectionState => ({
    name, loaded: Boolean(timestamp), loading: cleLoading, issue: cleIssue || cleData.warnings?.join(" / ") || "",
  });
  const tasksState = { ...cleState("CLEの課題", cleData.tasksUpdatedAt), issue: cleCollectionIssue(cleData, "tasks", cleIssue) };
  const surveysState = koanState("KOANのアンケート", data.surveysUpdatedAt);
  const scheduleState = koanState("時間割", data.scheduleUpdatedAt);
  const messagesState = { ...cleState("CLEの連絡", cleData.messagesUpdatedAt), issue: cleCollectionIssue(cleData, "messages", cleIssue) };
  const noticesState = koanState("KOANの掲示", data.noticesUpdatedAt || data.snapshotUpdatedAt);
  return (
    <>
      <section className="dashboard-main">
        <NextActions
          tasksState={tasksState}
          surveysState={surveysState}
          onRetry={onRetry}
          data={cleData}
          surveys={data.surveys}
        />
        <UpcomingChanges changes={data.changes} courses={data.courses} onSelectCourse={onSelectCourse} />
        <NewActivity
          messagesState={messagesState}
          announcementsState={cleState("CLEの授業連絡", cleData.announcementsUpdatedAt || null)}
          noticesState={noticesState}
          onRetry={onRetry}
          onShowNotices={onShowNotices}
          messages={cleData.messages}
          announcements={cleData.announcements}
          notices={data.notices}
          onOpen={onOpenNotice}
          onOpenAnnouncement={onOpenAnnouncement}
        />
      </section>
      <DashboardRightRail
        scheduleState={scheduleState}
        onRetry={onRetry}
        changes={selectedChanges}
        onSelectDate={setSelectedDate}
        schedule={selectedSchedule}
        selectedDate={selectedDate}
        surveys={data.surveys}
        tasks={cleData.tasks}
        allScheduleEmpty={data.schedule.length === 0}
        courses={data.courses || []}
        onSelectCourse={onSelectCourse}
      />
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SURVEY_ACTION_WINDOW_MS = 90 * DAY_MS;
const EXPIRED_TASK_VISIBLE_MS = 30 * DAY_MS;

function actionableSurveys(surveys: KoanSurvey[], now = Date.now()) {
  return surveys
    .filter((survey) => {
      if (survey.completed || !survey.endAt) return false;
      if (survey.status && !/受付|回答|実施/.test(survey.status)) return false;
      const endAt = new Date(survey.endAt).getTime();
      return Number.isFinite(endAt) &&
        endAt >= now &&
        endAt - now <= SURVEY_ACTION_WINDOW_MS;
    })
    .sort((left, right) =>
      new Date(left.endAt!).getTime() - new Date(right.endAt!).getTime(),
    );
}

function NextActions({
  tasksState,
  surveysState,
  onRetry,
  data,
  surveys,
}: {
  tasksState: CollectionState;
  surveysState: CollectionState;
  onRetry: () => void;
  data: CleData;
  surveys: KoanSurvey[];
}) {
  const now = Date.now();
  const pendingSurveys = actionableSurveys(surveys, now);
  const tasks = data.tasks.filter(
    (task) => !["提出済み", "採点済み"].includes(task.status),
  );
  const upcomingTasks = tasks
    .filter((task) => task.dueAt && new Date(task.dueAt).getTime() >= now)
    .sort(compareTaskDueAt);
  const noDueTasks = tasks
    .filter((task) => !task.dueAt)
    .sort(compareTaskDueAt);
  const expiredTasks = tasks
    .filter((task) => {
      if (!task.dueAt) return false;
      const dueAt = new Date(task.dueAt).getTime();
      return dueAt < now && dueAt >= now - EXPIRED_TASK_VISIBLE_MS;
    })
    .sort((left, right) => compareTaskDueAt(right, left));
  const archivedExpiredCount = tasks.filter((task) =>
    task.dueAt && new Date(task.dueAt).getTime() < now - EXPIRED_TASK_VISIBLE_MS,
  ).length;
  const states = [tasksState, surveysState];
  const ready = states.every(collectionReady);
  const actionGroups = groupDeadlineActions([...upcomingTasks, ...noDueTasks], pendingSurveys, now);
  return (
    <section className="section next-actions">
      <div className="section-heading">
        <div>
          <h2>課題・締切</h2>
          <p>KOANアンケート / CLE課題</p>
        </div>
      </div>
      <div className="task-list">
        <CollectionFeedback states={states} onRetry={onRetry} hasContent={!!actionGroups.length || !!expiredTasks.length} />
        {actionGroups.map((group) => {
          const deferred = group.label === "それ以降" || group.label === "期限未設定";
          const Group = deferred ? "details" : "section";
          return <Group className={`deadline-group${deferred ? " deferred" : ""}`} aria-label={group.label} key={group.label}>
            {deferred ? <summary>{group.label} {group.actions.length}件<small>{group.actions[0].dueAt ? `最短 ${fmtDue(group.actions[0].dueAt)}` : ""}</small></summary> : <h3>{group.label}</h3>}
            {group.actions.map((action) => action.kind === "task" ? (
              <CleTaskRow task={action.task} key={`task-${action.task.id}`} />
            ) : (
              <AuthenticatedLink
                className="cle-task-row koan-survey-row"
                href={SURVEYS_URL}
                key={`survey-${action.survey.title}-${action.survey.courseName}-${action.dueAt}`}
                target="_blank"
              >
                <time>{dueLabel(action.dueAt)}</time>
                <span>
                  {action.survey.title}
                  <small>KOANアンケート / {action.survey.courseName || "全学"} / {fmtDue(action.dueAt)}まで</small>
                </span>
              </AuthenticatedLink>
            ))}
          </Group>;
        })}
        {!actionGroups.length && ready && (
          <EmptyState
            icon="check-circle"
            title={expiredTasks.length ? "これから締切を迎える課題はありません" : "対応が必要な課題・締切はありません"}
            description={expiredTasks.length ? "期限を過ぎた課題は、下の一覧で確認できます。" : "期限の近いアンケートや未完了課題はありません。"}
            variant="dashboard"
          />
        )}
        {!!expiredTasks.length && (
          <details className="expired-tasks">
            <summary>期限切れ <b>{expiredTasks.length}</b></summary>
            {expiredTasks.map((task) => <CleTaskRow task={task} key={task.id} />)}
          </details>
        )}
        {!!tasks.length && <p className="task-link-note">CLE課題は、各授業の成績・課題一覧で開きます。</p>}
        {!!archivedExpiredCount && (
          <p className="archived-task-note">
            30日より前の期限切れ {archivedExpiredCount}件は授業詳細で確認できます。
          </p>
        )}
      </div>
    </section>
  );
}

function CleTaskRow({ task }: { task: CleTask }) {
  return (
    <AuthenticatedLink className="cle-task-row" href={cleTaskUrl(task)} target="_blank" title="CLEの成績・課題一覧で確認">
      <time>{dueLabel(task.dueAt)}</time>
      <span>
        {task.title}
        <small>{courseDisplayName(task.courseName)} / {taskDueDescription(task)} / {taskDisplayStatus(task)}</small>
      </span>
    </AuthenticatedLink>
  );
}

function noticeRecencyTime(notice: Notice) {
  const match = notice.period.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})|(\d{1,2})[/-](\d{1,2})/);
  if (!match) return 0;
  const currentYear = new Date().getFullYear();
  const year = match[1] ? Number(match[1]) : currentYear;
  const month = Number(match[2] || match[4]);
  const day = Number(match[3] || match[5]);
  return new Date(year, month - 1, day).getTime();
}

function scopeNoticeReason(notice: Notice) {
  return attentionScore(notice) >= 120
    ? <p className="notice-candidate-reason">候補の理由：{noticeAttentionReason(notice)}</p>
    : null;
}

function isImportantNotice(notice: Notice) {
  return isUniversityImportant(notice);
}


function Grades({
  data,
  loading,
  status,
}: {
  data: GradeData | null;
  loading: boolean;
  status: string;
}) {
  const error = Boolean(
    status &&
    !loading &&
    !status.includes("更新しました") &&
    !status.includes("キャッシュ表示中") &&
    !isPartialStatus(status),
  );
  return (
    <div className="grades-page">
      {!data ? (
        <section className="section">
          <EmptyState
            icon={loading ? "spinner" : error ? "info" : "graduation-cap"}
            title={loading ? "成績を取得しています" : error ? "成績を読み込めませんでした" : "成績はまだ取得していません"}
            description={loading ? "画面を切り替えても取得は続きます。" : error ? "ヘッダーの同期の詳細を確認してください。" : "右上の更新ボタンからKOANの履修成績を読み込めます。"}
            headingLevel={2}
            variant="normal"
          />
        </section>
      ) : (
        <>
          <section className="grade-metrics" aria-label="成績概要">
            <div><span>修得単位数</span><strong>{data.creditsTotal ?? "不明"}</strong></div>
            <div><span>通算 GPA</span><strong>{data.cumulativeGpa || "不明"}</strong></div>
            <div><span>修得科目</span><strong>{data.courses.length}</strong></div>
            <div><span>履修履歴</span><strong>{data.history.length}</strong></div>
          </section>

          <section className="section grade-section">
            <div className="section-heading">
              <div>
                <h2>科目小区分</h2>
              </div>
            </div>
            <div className="credit-groups">
              {!data.groups.length && <EmptyState icon="graduation-cap" title="表示できる科目区分はありません" variant="subtle" />}
              {data.groups.map((group) => (
                <details key={group.name}>
                  <summary>
                    <span>{group.name}<small className="credit-course-count">{group.courses.length}科目</small></span>
                    <b>{group.credits} 単位</b>
                  </summary>
                  <GradeTable courses={group.courses} />
                </details>
              ))}
            </div>
          </section>

          {!!data.termGpas.length && (
            <section className="grade-gpa-grid">
              <div className="section grade-section compact-section">
                <div className="section-heading"><h2>学期 GPA</h2></div>
                <table className="record-table">
                  <caption className="sr-only">学期ごとの GPA</caption>
                  <thead><tr><th scope="col">年度</th><th scope="col">学期</th><th scope="col">GPA</th></tr></thead>
                  <tbody>
                    {data.termGpas.map((item, index) => (
                      <tr key={`${item.year}-${item.term}-${index}`}>
                        <td>{item.year}</td><td>{item.term}</td><td>{item.gpa}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <GpaTrend termGpas={data.termGpas} />
            </section>
          )}

          <section className="section grade-section">
            <div className="section-heading">
              <div>
                <h2>履修成績</h2>
              </div>
            </div>
            {!data.history.length ? <EmptyState icon="graduation-cap" title="履修成績はありません" variant="subtle" /> : <div className="table-scroll">
              <table className="record-table">
                <caption className="sr-only">履修成績</caption>
                <thead><tr><th scope="col">科目名</th><th scope="col">教員</th><th scope="col">年度</th><th scope="col">評語</th><th scope="col">合否</th></tr></thead>
                <tbody>
                  {data.history.map((item, index) => (
                    <tr key={`${item.code}-${index}`}>
                      <td>{item.course}</td><td>{item.teacher}</td><td>{item.year}</td><td>{item.grade}</td><td>{item.pass}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
          </section>
        </>
      )}
    </div>
  );
}

function GpaTrend({
  termGpas,
}: {
  termGpas: GradeData["termGpas"];
}) {
  const points = buildGpaTrendPoints(termGpas);
  const chartRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 590, height: 285 });

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextWidth = Math.round(entry.contentRect.width);
        const nextHeight = Math.round(entry.contentRect.height);
        if (nextWidth > 0 && nextHeight > 0) {
          setSize((prev) => {
            if (prev.width === nextWidth && prev.height === nextHeight) {
              return prev;
            }
            return { width: nextWidth, height: nextHeight };
          });
        }
      });
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, []);

  const width = Math.max(300, size.width);
  const height = Math.max(260, size.height);
  const margin = { top: 35, right: 25, bottom: 50, left: 42 };
  const plotWidth = Math.max(10, width - margin.left - margin.right);
  const plotHeight = Math.max(10, height - margin.top - margin.bottom);
  const x = (index: number) =>
    margin.left + (points.length <= 1 ? plotWidth / 2 : (plotWidth * index) / (points.length - 1));
  const y = (value: number) => margin.top + plotHeight - (plotHeight * value) / 4;
  const gpaPolyline = points.map((point, index) => `${x(index)},${y(point.gpa)}`).join(" ");

  return (
    <section className="section grade-section gpa-trend">
      <div className="section-heading">
        <div>
          <h2>GPA 推移</h2>
          <p>KOANに記録された学期ごとの公式 GPA</p>
        </div>
      </div>
      <div className="gpa-chart" ref={chartRef}>
        <svg aria-label="学期ごとの公式 GPA の推移" role="img" viewBox={`0 0 ${width} ${height}`}>
          {[0, 1, 2, 3, 4].map((tick) => (
            <g className="gpa-grid-line" key={tick}>
              <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} />
              <text x={margin.left - 11} y={y(tick) + 4}>{tick.toFixed(1)}</text>
            </g>
          ))}
          {!!points.length && <polyline className="gpa-line cumulative" points={gpaPolyline} />}
          {points.map((point, index) => (
            <g className="gpa-point cumulative" key={point.key}>
              <circle cx={x(index)} cy={y(point.gpa)} r="4" />
              <text className="gpa-value" x={x(index)} y={y(point.gpa) - 12}>{point.gpa.toFixed(2)}</text>
              <text className="gpa-label" x={x(index)} y={height - 24}>
                <tspan x={x(index)} dy="0">{point.year}</tspan>
                <tspan x={x(index)} dy="13">{point.term}</tspan>
              </text>
            </g>
          ))}
        </svg>
      </div>
    </section>
  );
}

function GradeTable({ courses }: { courses: GradeData["courses"] }) {
  const categories = [...new Set(courses.map(course => course.majorCategory))];
  const commonCategory = categories.length === 1 ? categories[0] : "";
  return (
    <div className="grade-group-content">
      {commonCategory && <p className="grade-common-category">詳細区分：{commonCategory}</p>}
      <div className="table-scroll">
      <table className="record-table grade-course-table">
        <colgroup><col className="grade-course-col" />{!commonCategory && <col className="grade-category-col" />}<col className="grade-term-col" /><col className="grade-number-col" /><col className="grade-number-col" /></colgroup>
        <caption className="sr-only">科目小区分の成績一覧</caption>
        <thead><tr><th scope="col">科目名</th>{!commonCategory && <th scope="col">詳細区分</th>}<th scope="col">年度・学期</th><th scope="col">単位</th><th scope="col">評語</th></tr></thead>
        <tbody>
          {courses.map((course, index) => (
            <tr key={`${course.course}-${course.year}-${index}`}>
              <td>{course.course}</td>{!commonCategory && <td>{course.majorCategory}</td>}<td>{course.year} {course.term}</td><td>{course.credits}</td><td>{course.grade || course.pass}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

const dateKey = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(date.getMonth() + months, 1);
  return next;
}

function dateFromKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function monthGrid(monthDate: Date) {
  const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const start = addDays(firstDay, -firstDay.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = addDays(start, index);
    return {
      date,
      inMonth: date.getMonth() === monthDate.getMonth(),
      key: dateKey(date),
    };
  });
}

function monthLabel(date: Date) {
  return new Intl.DateTimeFormat("ja-JP", { month: "long", year: "numeric" }).format(date);
}

function selectedDateLabel(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(dateFromKey(value));
}

function selectedClassHeading(value: string) {
  const date = dateFromKey(value);
  return `${date.getMonth() + 1}/${date.getDate()} (${new Intl.DateTimeFormat("ja-JP", {
    weekday: "narrow",
  }).format(date)}) の授業`;
}

function periodNumber(value: string) {
  return value.match(/\d+/)?.[0] || "";
}


function DashboardRightRail({
  scheduleState,
  onRetry,
  changes,
  onSelectDate,
  schedule,
  selectedDate,
  surveys,
  tasks,
  allScheduleEmpty,
  courses,
  onSelectCourse,
}: {
  scheduleState: CollectionState;
  onRetry: () => void;
  changes: ChangeItem[];
  onSelectDate: (date: string) => void;
  schedule: ScheduleItem[];
  selectedDate: string;
  surveys: KoanSurvey[];
  tasks: CleTask[];
  allScheduleEmpty: boolean;
  courses: CourseRegistration[];
  onSelectCourse: (code: string) => void;
}) {
  const today = dateKey(new Date());
  const [visibleMonth, setVisibleMonth] = useState(() => new Date());
  const moveMonth = (months: number) => setVisibleMonth((current) => addMonths(current, months));
  const selectCalendarDate = (date: string) => {
    onSelectDate(date);
    const nextDate = dateFromKey(date);
    setVisibleMonth((current) => (
      current.getFullYear() === nextDate.getFullYear() && current.getMonth() === nextDate.getMonth()
        ? current
        : new Date(nextDate.getFullYear(), nextDate.getMonth(), 1)
    ));
  };
  const periods = ["1", "2", "3", "4", "5", "6"];
  const activeTasks = useMemo(
    () => tasks.filter((task) => !["提出済み", "採点済み"].includes(task.status)),
    [tasks],
  );
  const activeSurveys = useMemo(() => actionableSurveys(surveys), [surveys]);
  const deadlineDates = useMemo(
    () => new Set([
      ...activeTasks
        .filter((task) => task.dueAt)
        .map((task) => dateKey(new Date(task.dueAt!))),
      ...activeSurveys.map((survey) => dateKey(new Date(survey.endAt!))),
    ]),
    [activeSurveys, activeTasks],
  );
  return (
    <aside className="dashboard-right-rail">
      <section className="rail-section calendar-panel">
        <MonthCalendar
          deadlineDates={deadlineDates}
          month={visibleMonth}
          onNextMonth={() => moveMonth(1)}
          onPreviousMonth={() => moveMonth(-1)}
          onSelectDate={selectCalendarDate}
          selectedDate={selectedDate}
          today={today}
        />
      </section>
      <section className="rail-section selected-day-panel">
        <div className="rail-heading">
          <div>
            <h2>{selectedClassHeading(selectedDate)}</h2>
          </div>
        </div>
        <CollectionFeedback states={[scheduleState]} onRetry={onRetry} hasContent={!!schedule.length} />
        <div className="rail-schedule-list">
          {allScheduleEmpty ? (collectionReady(scheduleState) ? (
            <EmptyState
              icon="calendar"
              title="この期間の時間割はありません"
              variant="rail"
            />
          ) : null) : (
            <>
              {periods.map((period) => {
                const item = schedule.find((scheduleItem) => periodNumber(scheduleItem.period) === period);
                const change = item ? changeFor(item, changes) : null;
                const matchedCourse = item
                  ? courses.find((course) => courseMatchesText(course, item.title))
                  : null;

                if (matchedCourse && item) {
                  return (
                    <button
                      className="rail-schedule-row clickable-period"
                      key={period}
                      onClick={() => onSelectCourse(matchedCourse.code)}
                      title={`${item.title}の詳細を表示`}
                      type="button"
                    >
                      <b>{period}</b>
                      <span>
                        <span className="rail-course-title">{item.title}</span>
                        {item.room && <small>{item.room}</small>}
                        {change && <em>{change.type}</em>}
                      </span>
                    </button>
                  );
                }

                return (
                  <div className={`rail-schedule-row ${item ? "" : "empty-period"}`} key={period}>
                    <b>{period}</b>
                    <span>
                      {item ? (
                        <>
                          <span className="rail-course-title">{item.title}</span>
                          {item.room && <small>{item.room}</small>}
                          {change && <em>{change.type}</em>}
                        </>
                      ) : (
                        "-"
                      )}
                    </span>
                  </div>
                );
              })}
              {schedule
                .filter((item) => !periodNumber(item.period))
                .map((item, index) => (
                  <div
                    className="rail-change-row"
                    key={`${item.date}-${item.title}-${index}`}
                  >
                    <b>{item.kind === "holiday" ? "休日" : "予定"}</b>
                    <span>
                      {item.title}
                      {item.room && <small>{item.room}</small>}
                    </span>
                  </div>
                ))}
              {changes
                .filter((change) => !schedule.some((item) => changeFor(item, [change])))
                .map((item, index) => (
                  <div className="rail-change-row" key={`${item.date}-${item.period}-${index}`}>
                    <b>{item.type}</b>
                    <span>{item.period}<small>{item.course}</small></span>
                  </div>
                ))}
            </>
          )}
        </div>
      </section>

    </aside>
  );
}

function MonthCalendar({
  deadlineDates,
  month,
  onNextMonth,
  onPreviousMonth,
  onSelectDate,
  selectedDate,
  today,
}: {
  deadlineDates: Set<string>;
  month: Date;
  onNextMonth: () => void;
  onPreviousMonth: () => void;
  onSelectDate: (date: string) => void;
  selectedDate: string;
  today: string;
}) {
  const days = monthGrid(month);
  return (
    <div className="month-calendar">
      <div className="month-heading">
        <button aria-label="前の月" onClick={onPreviousMonth} type="button">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide-icon chevron-left">
            <path d="m15 18-6-6 6-6"/>
          </svg>
        </button>
        <h3>{monthLabel(month)}</h3>
        <button aria-label="次の月" onClick={onNextMonth} type="button">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide-icon chevron-right">
            <path d="m9 18 6-6-6-6"/>
          </svg>
        </button>
      </div>
      <div className="calendar-weekdays">
        {["日", "月", "火", "水", "木", "金", "土"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-days">
        {days.map((day) => {
          return (
            <button
              aria-current={day.key === today ? "date" : undefined}
              aria-label={`${selectedDateLabel(day.key)}を選択${deadlineDates.has(day.key) ? "、締切あり" : ""}`}
              aria-pressed={day.key === selectedDate}
              className={[
                day.inMonth ? "" : "outside",
                day.key === selectedDate ? "selected" : "",
                day.key === today ? "today" : "",
                deadlineDates.has(day.key) ? "has-deadline" : "",
              ].filter(Boolean).join(" ")}
              key={day.key}
              onClick={() => onSelectDate(day.key)}
              type="button"
            >
              <span>{day.date.getDate()}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function changeMatchesDate(change: ChangeItem, date: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(change.date)) {
    return change.date === date;
  }
  const match = change.date.match(/(\d{1,2})[\/月](\d{1,2})/);
  if (!match) return false;
  const [, month, day] = date.split("-");
  return Number(month) === Number(match[1]) && Number(day) === Number(match[2]);
}

function changesForDate(changes: ChangeItem[], date: string, today: string) {
  return changes.filter(
    (item) => changeMatchesDate(item, date) || (date === today && item.date === "今週"),
  );
}

function changeFor(schedule: ScheduleItem, changes: ChangeItem[]) {
  return changes.find((change) => {
    const sameDate = !schedule.date || changeMatchesDate(change, schedule.date);
    const samePeriod = change.period && change.period === schedule.period;
    const sameCourse =
      change.course &&
      (change.course.includes(schedule.title) || schedule.title.includes(change.course));
    return sameDate && samePeriod && sameCourse;
  });
}


function NewActivity({
  messagesState, announcementsState, noticesState, onRetry, onShowNotices, messages, announcements = [], notices,
  onOpen, onOpenAnnouncement,
}: {
  messagesState: CollectionState;
  announcementsState: CollectionState;
  noticesState: CollectionState;
  onRetry: () => void;
  onShowNotices: () => void;
  messages: CleData["messages"];
  announcements?: CleAnnouncement[];
  notices: Notice[];
  onOpen: (notice: Notice) => void;
  onOpenAnnouncement: (ann: CleAnnouncement) => void;
}) {
  const [importantOnly, setImportantOnly] = useState(true);
  const [messageLimit, setMessageLimit] = useState(2);
  const [cleLimit, setCleLimit] = useState(3);
  const [koanLimit, setKoanLimit] = useState(3);
  const groups = homeCommunicationGroups(notices, announcements, messages);
  const important = groups.koan.filter((item) => item.kind === "notice" && isUniversityImportant(item.notice));
  const koanItems = importantOnly ? important : groups.koan;
  const cleStates = [messagesState, announcementsState];
  const list = (items: CommunicationItem[]) => <CommunicationList items={items} snapshotNotices={notices} onOpenNotice={onOpen} onOpenAnnouncement={onOpenAnnouncement} showSource={false} />;
  const more = (label: string, remaining: number, onClick: () => void) => remaining > 0 && <button className="detail-link communication-more" type="button" onClick={onClick}>{label}をさらに表示（残り {remaining}件）</button>;
  return <>
    <section className="communications-section" aria-label="CLEの連絡">
      <div className="section-heading"><h2>CLEの連絡</h2><AuthenticatedLink className="detail-link" href={CLE_MESSAGES_URL} target="_blank">CLEを開く</AuthenticatedLink></div>
      <CollectionFeedback states={cleStates} onRetry={onRetry} hasContent={!!(groups.messages.length || groups.cle.length)} />
      {list(groups.messages.slice(0, messageLimit))}
      {more("未読メッセージ", groups.messages.length - messageLimit, () => setMessageLimit((value) => value + 6))}
      {list(groups.cle.slice(0, cleLimit))}
      {more("CLEの連絡", groups.cle.length - cleLimit, () => setCleLimit((value) => value + 6))}
      {!groups.messages.length && !groups.cle.length && <p className="communication-empty">{cleStates.every(collectionReady) ? "CLEの連絡はありません" : "取得済みの情報にCLEの連絡はありません"}</p>}
    </section>
    <section className="communications-section" aria-label="KOANのお知らせ">
      <div className="section-heading">
        <h2>KOANのお知らせ</h2>
        <div className="communication-heading-actions"><div className="communication-filters" role="group" aria-label="KOANのお知らせの絞り込み">
          <button type="button" aria-pressed={!importantOnly} onClick={() => { setImportantOnly(false); setKoanLimit(3); }}>最新</button>
          <button className="communication-important-filter" type="button" title="大学の重要指定" aria-pressed={importantOnly} onClick={() => { setImportantOnly(true); setKoanLimit(3); }}>重要</button>
        </div><button className="detail-link" type="button" onClick={onShowNotices}>掲示を検索</button></div>
      </div>
      <CollectionFeedback states={[noticesState]} onRetry={onRetry} hasContent={!!groups.koan.length} />
      {list(koanItems.slice(0, koanLimit))}
      {!koanItems.length && <p className="communication-empty">{importantOnly ? "取得済みの情報に重要なお知らせはありません" : collectionReady(noticesState) ? "KOANのお知らせはありません" : "取得済みの情報にKOANのお知らせはありません"}</p>}
      {more("KOANのお知らせ", koanItems.length - koanLimit, () => setKoanLimit((value) => value + 6))}
    </section>
  </>;
}

function CommunicationList({ items, snapshotNotices, onOpenNotice, onOpenAnnouncement, showSource = true }: {
  showSource?: boolean;
  items: CommunicationItem[];
  snapshotNotices: Notice[];
  onOpenNotice: (notice: Notice) => void;
  onOpenAnnouncement: (ann: CleAnnouncement) => void;
}) {
  return <div className="communication-list">{items.map((item) => {
    if (item.kind === "notice") return <ActivityNotice key={item.key} notice={item.notice} snapshotNotices={snapshotNotices} onOpen={onOpenNotice} showSource={showSource} />;
    if (item.kind === "announcement") {
      const ann = item.announcement;
      return <button className="communication-row" key={item.key} type="button" onClick={() => onOpenAnnouncement(ann)}>
        <span className="communication-attention" aria-hidden="true" />
        <span className="communication-content"><strong>{ann.title}</strong><small>{courseDisplayName(ann.courseName)}{showSource && <span className="communication-source">CLE</span>}</small></span>
        <span className="communication-state"><time dateTime={ann.created}>{activityDateLabel(ann.created)}</time></span>
      </button>;
    }
    const message = item.message;
    return <AuthenticatedLink className="communication-row communication-message" key={item.key} href={cleMessageUrl(message.courseId)} target="_blank">
      <span className="communication-attention">未読</span>
      <span className="communication-content"><strong>{courseDisplayName(message.courseName)}</strong><small>本文を確認{showSource && <span className="communication-source">CLE</span>}</small></span>
      <span className="communication-state unread">{message.unreadCount}件</span>
    </AuthenticatedLink>;
  })}</div>;
}

async function openNoticePage(notice: Notice, notices: Notice[], onOpen: (notice: Notice) => void) {
  const knownUrl = getKnownNoticeUrl(notice, notices);
  // Use the click's activation, including when lookup will need a network call.
  const detailWindow = window.open(knownUrl || "", "_blank");
  if (!detailWindow) throw new Error("新しいタブを開けませんでした。ブラウザのポップアップ設定を確認してください。");
  detailWindow.opener = null;
  if (knownUrl) {
    onOpen(notice);
    return;
  }
  detailWindow.document.title = "掲示を開いています";
  detailWindow.document.body.textContent = "掲示のリンクを確認しています…";
  try {
    await ensureKoanLogin();
    if (detailWindow.closed) return;
    const url = await resolveNoticeUrl(notice, notices);
    if (detailWindow.closed) return;
    detailWindow.location.replace(url || BOARD_URL);
    if (url) onOpen(notice);
  } catch (error) {
    if (!detailWindow.closed) detailWindow.location.replace(BOARD_URL);
    throw error;
  }
}

function ActivityNotice({ notice, snapshotNotices, onOpen, showSource }: {
  showSource: boolean;
  notice: Notice; snapshotNotices: Notice[]; onOpen: (notice: Notice) => void;
}) {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const openNotice = async () => {
    setOpening(true);
    setOpenError("");
    try { await openNoticePage(notice, snapshotNotices, onOpen); }
    catch (error) { setOpenError(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(false); }
  };
  const important = isUniversityImportant(notice);
  return <><button className={`communication-row${important ? " communication-important" : ""}`} type="button" disabled={opening} onClick={openNotice}>
    <span className="communication-attention" title={important ? "大学の重要指定" : undefined}>{important && <>重要<span className="sr-only">（大学の指定）</span></>}</span>
    <span className="communication-content"><strong>{notice.title}</strong><small>{[notice.genre, notice.department, notice.period].filter(Boolean).join(" / ")}{showSource && <span className="communication-source">KOAN</span>}</small></span>
    <span className="communication-state">{opening ? "取得中" : notice.unread && <span className="unread">未読</span>}</span>
  </button>{openError && <p className="inline-error" role="alert">{openError}</p>}</>;
}

function UpcomingChanges({ changes, courses, onSelectCourse }: {
  changes: ChangeItem[]; courses: CourseRegistration[]; onSelectCourse: (code: string) => void;
}) {
  const upcoming = upcomingChanges(changes);
  if (!upcoming.length) return null;
  return <section className="upcoming-changes" aria-label="直近の休講・変更">
    <div className="section-heading"><h2>直近の休講・変更</h2><span className="changes-period">今後7日間</span></div>
    {upcoming.map((change, i) => {
      const course = courses.find((item) => courseMatchesText(item, change.course));
      const content = <><strong>{change.type}</strong><span>{change.course}<small>{change.date === "今週" ? "今週（日付未確定）" : change.date} {change.period && `${change.period.replace(/限$/, "")}限`}</small></span></>;
      return course ? <button type="button" className="upcoming-change-row" key={i} onClick={() => onSelectCourse(course.code)}>{content}</button> : <div className="upcoming-change-row" key={i}>{content}</div>;
    })}
  </section>;
}

function ReferenceDesk({
  allNotices,
  genre,
  notices,
  loading,
  error,
  partial,
  loaded,
  onGenreChange,
  onOpen,
  onQueryChange,
  onScopeChange,
  query,
  scope,
}: {
  allNotices: Notice[];
  genre: string;
  notices: Notice[];
  loading: boolean;
  error: string;
  partial: string;
  loaded: boolean;
  onGenreChange: (value: string) => void;
  onOpen: (notice: Notice) => void;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: string) => void;
  query: string;
  scope: string;
}) {
  const summary = {
    all: allNotices.length,
    unread: allNotices.filter((notice) => notice.unread).length,
    attention: allNotices.filter((notice) => attentionScore(notice) >= 120).length,
    important: allNotices.filter(isImportantNotice).length,
    benefits: allNotices.filter((notice) => noticeBenefit(notice)).length,
  };
  const tabs = [
    ["important", "重要", summary.important],
    ["attention", "要確認", summary.attention],
    ["unread", "未読", summary.unread],
    ["benefits", "特典・謝礼", summary.benefits],
    ["all", "すべて", summary.all],
  ] as const;

  return (
    <div className="reference-page">
      <section className="notice-operations" aria-label="掲示の絞り込み">
        <div className="notice-scope-tabs" role="group" aria-label="状態で絞り込む">
          {tabs.map(([value, label, count]) => (
            <button
              aria-pressed={scope === value}
              className={scope === value ? "active" : ""}
              key={value}
              onClick={() => onScopeChange(value)}
              type="button"
            >
              <span>{label}</span>
              <b>{count}</b>
            </button>
          ))}
        </div>
        <div className="notice-tools">
          <input aria-label="掲示を検索" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="掲示を検索" />
          <select aria-label="ジャンルで絞り込む" value={genre} onChange={(event) => onGenreChange(event.target.value)}>
            <option value="">全ジャンル</option>
            {GENRES.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
      </section>

      <section className="notice-list-section" aria-label="掲示一覧">
        <NoticeList
          allNotices={allNotices}
          error={error}
          partial={partial}
          loaded={loaded}
          loading={loading}
          showReasons={scope === "attention"}
          showBenefits={scope === "benefits"}
          notices={notices}
          onOpen={onOpen}
        />
      </section>
    </div>
  );
}

function NoticeList({
  showBenefits,
  showReasons,
  allNotices,
  error,
  partial,
  loaded,
  loading,
  notices,
  onOpen,
}: {
  showReasons: boolean;
  showBenefits: boolean;
  allNotices: Notice[];
  error: string;
  partial: string;
  loaded: boolean;
  loading: boolean;
  notices: Notice[];
  onOpen: (notice: Notice) => void;
}) {
  const [opening, setOpening] = useState("");
  const [openError, setOpenError] = useState("");
  const openNotice = async (notice: Notice) => {
    setOpening(noticeKey(notice));
    setOpenError("");
    try { await openNoticePage(notice, allNotices, onOpen); }
    catch (error) { setOpenError(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(""); }
  };

  const state = loading && !notices.length
    ? (
      <EmptyState
        icon="spinner"
        title="掲示を取得しています"
        description="画面を切り替えても取得は続きます。"
        headingLevel={2}
        variant="normal"
      />
    )
      : error && !notices.length
      ? (
        <EmptyState
          icon="info"
          title="掲示を読み込めませんでした"
          description="ヘッダーの同期の詳細を確認してください。"
          headingLevel={2}
          variant="normal"
        />
      )
      : partial && !notices.length
        ? (
          <EmptyState
            icon="info"
            title="掲示を一部取得できませんでした"
            description="ヘッダーの同期の詳細を確認してください。"
            headingLevel={2}
            variant="normal"
          />
        )
      : !loaded && !notices.length
        ? (
          <EmptyState
            icon="inbox"
            title="まだ取得していません"
            description="右上の更新ボタンからKOANの掲示を読み込めます。"
            headingLevel={2}
            variant="normal"
          />
        )
        : !notices.length
          ? (
            <EmptyState
              icon={allNotices.length ? "search" : "inbox"}
              title={allNotices.length ? "条件に一致する掲示はありません" : "掲示はありません"}
              description={allNotices.length ? "検索キーワードや絞り込み条件を変更してください。" : undefined}
              headingLevel={2}
              variant="normal"
            />
          )
          : null;
  if (state) return state;
  const importantNotices = notices.filter(isImportantNotice);
  const otherNotices = notices.filter((notice) => !isImportantNotice(notice));
  const showGroups = Boolean(importantNotices.length && otherNotices.length);
  const renderRows = (items: Notice[]) => items.map((notice) => {
    const key = noticeKey(notice);
    const openingThis = opening === key;
    return (
      <button
        className={[
          "notice-row",
          notice.unread ? "unread" : "",
          isImportantNotice(notice) ? "important" : "",
        ].filter(Boolean).join(" ")}
        type="button"
        disabled={Boolean(opening)}
        onClick={() => openNotice(notice)}
        key={key}
      >
        <div className="notice-content">
          <div className="notice-row-meta">
            <span className="notice-chip genre-chip">{notice.genre}</span>
            {notice.unread && <span className="notice-chip state-chip">未読</span>}
            {isImportantNotice(notice) && <span className="notice-chip state-chip important-chip" title="大学の重要指定">重要</span>}
            {!showReasons && !isImportantNotice(notice) && attentionScore(notice) >= 120 && <span className="notice-chip candidate-chip" title={noticeAttentionReason(notice)}>要確認</span>}
            {notice.isNew && <span className="notice-chip state-chip">新着</span>}
            {openingThis && <span className="notice-chip state-chip">取得中</span>}
          </div>
          <h3 title={notice.title}>{notice.title}</h3>
          <p>{[notice.department, notice.author].filter(Boolean).join(" / ") || "発信元未取得"}</p>
          {showReasons && scopeNoticeReason(notice)}
          {showBenefits && noticeBenefit(notice) && <p className="notice-benefit-reason">{noticeBenefit(notice)!.label}</p>}
        </div>
        <time>{notice.period || "期間未取得"}</time>
      </button>
    );
  });

  return (
    <div className="notice-list">
      {openError && <p className="inline-error" role="alert">{openError}</p>}
      {showGroups ? (
        <>
          <div className="notice-group-heading">
            <h2>重要</h2>
            <span>{importantNotices.length}件</span>
          </div>
          {renderRows(importantNotices)}
          <div className="notice-group-heading secondary">
            <h2>その他の掲示</h2>
            <span>{otherNotices.length}件</span>
          </div>
          {renderRows(otherNotices)}
        </>
      ) : renderRows(notices)}
    </div>
  );
}

export default App;
