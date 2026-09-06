import { useEffect, useRef, useState } from "react";
import privacyDocument from "../PRIVACY.md?raw";
import termsDocument from "../TERMS.md?raw";
import { loadAuthSettings, requestAuthenticationInfoPermission, saveAuthSettings } from "./auth";
import ThemeToggle, { loadTheme, saveTheme } from "./ThemeToggle";
import { useEscapeKey } from "./useEscapeKey";

type OnboardingProps = {
  onComplete: (openSettings: boolean) => boolean;
};

type Step = "welcome" | "credentials";
type LegalDocument = "terms" | "privacy";

function plainLegalText(document: string) {
  return document
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/^- /gm, "• ");
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [theme, setTheme] = useState(loadTheme);
  const [accepted, setAccepted] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocument | null>(null);
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [existingCredentials, setExistingCredentials] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const legalDialogRef = useRef<HTMLElement | null>(null);
  const legalReturnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void loadAuthSettings()
      .then((settings) => setExistingCredentials(settings.configured))
      .catch(() => setExistingCredentials(false));
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (!saveTheme(theme)) {
      setStatus("表示設定をこの端末に保存できませんでした。ライトテーマで続行します。");
    }
  }, [theme]);

  const saveCredentials = async () => {
    if (!id.trim() || !password) return;
    setSaving(true);
    setStatus("");
    try {
      if (!await requestAuthenticationInfoPermission()) {
        setStatus("自動ログインを使用するには認証情報の利用許可が必要です。Firefoxの許可を確認してください。");
        return;
      }
      await saveAuthSettings({
        enabled: true,
        id: id.trim(),
        password,
        totpSecret: "",
        mfaConsent: false,
        mfaEnabled: false,
      });
      if (!finish(false)) return;
      setPassword("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const finish = (openSettings: boolean) => {
    if (!onComplete(openSettings)) {
      setStatus("この端末に同意状態を保存できませんでした。ストレージを確認して再試行してください。");
      return false;
    }
    return true;
  };

  useEffect(() => {
    if (!legalDocument) return;
    const dialog = legalDialogRef.current;
    if (!dialog) return;
    const focusableElements = () => [...dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])"
    )].filter((element) => element.getClientRects().length > 0);
    const focusable = focusableElements();
    (focusable[0] || dialog).focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const current = focusableElements();
      if (!current.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = current[0];
      const last = current[current.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      dialog.removeEventListener("keydown", trapFocus);
      if (legalReturnFocus.current?.isConnected) legalReturnFocus.current.focus();
      legalReturnFocus.current = null;
    };
  }, [legalDocument]);

  useEscapeKey(legalDocument ? () => setLegalDocument(null) : undefined);

  const openLegalDocument = (value: LegalDocument) => {
    legalReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setLegalDocument(value);
  };

  const stepNumber = step === "welcome" ? 1 : 2;
  const privacyJapanese = privacyDocument.includes("## 日本語")
    ? `# プライバシーポリシー\n\n${privacyDocument.split("## 日本語")[1].trim()}`
    : privacyDocument;

  return (
    <main className="page-layout onboarding-shell">
      <section className="onboarding-panel" aria-labelledby="onboarding-title">
        <header className="onboarding-header">
          <div>
            <p>大阪大学の学務ダッシュボード</p>
            <h1 id={step === "welcome" ? "onboarding-title" : undefined}>
              {step === "welcome" ? "KOAN Plus" : "自動ログイン設定"}
            </h1>
          </div>
          <div className="topbar-actions">
            <ThemeToggle onToggle={() => setTheme(theme === "light" ? "dark" : "light")} theme={theme} />
          </div>
        </header>

        {existingCredentials === false && (
          <div className="onboarding-progress" aria-label={`全2ステップ中${stepNumber}ステップ目`}>
            {["はじめに", "ログイン設定（任意）"].map((label, index) => (
              <div className={stepNumber >= index + 1 ? "active" : ""} key={label}>
                <span aria-current={stepNumber === index + 1 ? "step" : undefined} />
                <small>{label}</small>
              </div>
            ))}
          </div>
        )}

        <div className="onboarding-content">
          {step === "welcome" && (
            <div className="settings-form-block">
              <div className="onboarding-intro">
                <p>KOANとCLEの情報をまとめて、今日の予定と次にやることを確認できます。</p>
                <p className="onboarding-product-note">大学非公式の拡張機能です。取得した学務情報は、この端末内に保存します。</p>
              </div>

              <div className="onboarding-legal-links">
                <button onClick={() => openLegalDocument("terms")} type="button">利用規約を読む</button>
                <button onClick={() => openLegalDocument("privacy")} type="button">プライバシーポリシーを読む</button>
              </div>

              {status && <p className="settings-status onboarding-status" role="alert">{status}</p>}

              <label className="onboarding-consent">
                <input checked={accepted} onChange={(event) => setAccepted(event.target.checked)} type="checkbox" />
                <span>利用規約に同意し、プライバシーポリシーを確認しました。</span>
              </label>

              <div className="settings-actions onboarding-actions onboarding-actions-end">
                <div className="onboarding-actions-right">
                  <button
                    className="primary-action"
                    disabled={!accepted || existingCredentials === null}
                    onClick={() => existingCredentials ? finish(false) : setStep("credentials")}
                    type="button"
                  >
                    {existingCredentials ? "同意して利用開始" : "同意して次へ"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "credentials" && (
            <form
              className="settings-form-block"
              onSubmit={(event) => {
                event.preventDefault();
                void saveCredentials();
              }}
            >
              <div className="section-heading compact">
                <div>
                  <h2 id="onboarding-title">自動ログインを設定</h2>
                  <p>画面を開いている間、KOANとCLEの情報を自動で更新します。設定せずに、手動ログインで利用することもできます。</p>
                </div>
              </div>

              <div className="settings-grid onboarding-form">
                <label>
                  <span>大阪大学個人ID</span>
                  <input autoComplete="username" onChange={(event) => setId(event.target.value)} value={id} />
                </label>
                <label>
                  <span>パスワード</span>
                  <input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
                </label>
              </div>

              <p className="onboarding-storage-note">認証情報は暗号化してこの端末内に保存します。共用端末では設定しないでください。</p>
              {status && <p className="settings-status onboarding-status" role="alert">{status}</p>}

              <div className="settings-actions onboarding-actions">
                <div className="onboarding-actions-left">
                  <button className="secondary-action" onClick={() => setStep("welcome")} type="button">戻る</button>
                </div>
                <div className="onboarding-actions-right">
                  <button className="subtle-action" disabled={saving} onClick={() => finish(false)} type="button">あとで設定</button>
                  <button className="primary-action" disabled={saving || !id.trim() || !password} type="submit">
                    {saving ? "保存中…" : "保存して利用開始"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </section>

      {legalDocument && (
        <div className="onboarding-modal-overlay" onMouseDown={() => setLegalDocument(null)}>
          <section
            aria-labelledby={`legal-${legalDocument}-title`}
            aria-modal="true"
            className="onboarding-legal-modal"
            ref={legalDialogRef}
            role="dialog"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2 id={`legal-${legalDocument}-title`}>{legalDocument === "terms" ? "利用規約" : "プライバシーポリシー"}</h2>
              <button aria-label="閉じる" onClick={() => setLegalDocument(null)} type="button">閉じる</button>
            </header>
            <pre>{plainLegalText(legalDocument === "terms" ? termsDocument : privacyJapanese)}</pre>
          </section>
        </div>
      )}
    </main>
  );
}
