(() => {
  if (window.top !== window || window.__koanPlusAuthStarted) return;
  window.__koanPlusAuthStarted = true;
  const CLE_ORIGIN = "https://www.cle.osaka-u.ac.jp";
  const MFA_PENDING_TRANSACTION_KEY = "koan-plus-mfa-pending-transaction";

  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const visibleText = (element) => (element.textContent || element.value || "").replace(/\s+/g, " ").trim();

  const isFirefoxDataConsentEnv = () => {
    try {
      return new URL(chrome.runtime.getURL("")).protocol === "moz-extension:";
    } catch {
      return false;
    }
  };

  const proceedMfaRegistration = (proceedBtn) => {
    let transitionObserved = false;
    const firefoxDataConsent = isFirefoxDataConsentEnv();
    const markTransition = () => {
      transitionObserved = true;
    };
    const form = proceedBtn.form || proceedBtn.closest("form");
    form?.addEventListener("submit", markTransition, { once: true });
    window.addEventListener("pagehide", markTransition, { once: true });

    chrome.runtime.sendMessage({ type: "auth-mfa-click-proceed" }).then((response) => {
      if (firefoxDataConsent) return; // All Firefox submissions go through the permission-checked background.
      if ((!response?.ok || !response.started) && !transitionObserved) {
        proceedBtn.click();
      }
    }).catch(() => {
      if (!firefoxDataConsent && !transitionObserved) proceedBtn.click();
    });

    window.setTimeout(() => {
      if (transitionObserved || !document.contains(proceedBtn)) return;
      if (!firefoxDataConsent) proceedBtn.click();
    }, 500);

    window.setTimeout(() => {
      if (transitionObserved || !document.contains(proceedBtn)) return;
      chrome.runtime.sendMessage({
        type: "auth-mfa-click-proceed",
        forceFallback: true,
      }).catch(() => {});
    }, 1200);
  };

  const credentialsMatch = (idInput, passwordInput, credentials) => {
    const currentId = idInput.value.trim();
    const currentPassword = passwordInput.value;
    const idMatches = !currentId || currentId === credentials.id;
    const passwordMatches = !currentPassword || currentPassword === credentials.password;
    return idMatches && passwordMatches;
  };

  const submitIdpLogin = (loginSubmit) => {
    const form = loginSubmit.form || loginSubmit.closest("form");
    let submissionObserved = false;
    let permissionBlocked = false;
    // Chromeの既存fallbackは維持する一方、Firefoxではbackgroundの同意確認を迂回する直接送信を許可しない。
    const firefoxDataConsent = isFirefoxDataConsentEnv();
    const markSubmitted = () => {
      submissionObserved = true;
    };
    form?.addEventListener("submit", markSubmitted, { once: true });
    window.addEventListener("pagehide", markSubmitted, { once: true });

    chrome.runtime.sendMessage({ type: "auth-submit-idp" }).then((submitResponse) => {
      if (submitResponse?.permissionRequired) {
        permissionBlocked = true;
        return;
      }
      if (!submitResponse?.ok) {
        if (firefoxDataConsent) {
          permissionBlocked = true;
          return;
        }
        if (!submissionObserved) loginSubmit.click();
        return;
      }
      if (!submitResponse.started && !submissionObserved) {
        loginSubmit.click();
      }
    }).catch(() => {
      if (firefoxDataConsent) {
        permissionBlocked = true;
        return;
      }
      if (!submissionObserved) loginSubmit.click();
    });

    window.setTimeout(() => {
      if (permissionBlocked || submissionObserved || !document.contains(loginSubmit)) return;
      if (!firefoxDataConsent) {
        loginSubmit.click();
      }
    }, 500);

    window.setTimeout(() => {
      if (permissionBlocked || submissionObserved ||
          !document.contains(loginSubmit) ||
          !(form instanceof HTMLFormElement)) return;
      if (!firefoxDataConsent) {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit(loginSubmit);
        } else {
          loginSubmit.click();
        }
        return;
      }
      chrome.runtime.sendMessage({ type: "auth-submit-idp" }).then((response) => {
        if (response?.permissionRequired) {
          permissionBlocked = true;
          return;
        }
        if (!response?.ok) {
          permissionBlocked = true;
          return;
        }
        if (!response.started && !submissionObserved) {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit(loginSubmit);
          } else {
            loginSubmit.click();
          }
        }
      }).catch(() => {
        permissionBlocked = true;
      });
    }, 1200);
  };

  const findOtpInput = () => {
    const explicit = document.getElementById("OTP_CODE") ||
      document.querySelector('input[name="OTP_CODE"]') ||
      document.getElementById("totp-verification-input") ||
      document.querySelector('input[name="secondaryAuthToken"]');
    if (explicit instanceof HTMLInputElement && !["hidden", "checkbox", "submit", "button"].includes(explicit.type)) {
      return explicit;
    }

    return [...document.querySelectorAll("input")].find((input) => {
      const hint = [input.id, input.name, input.autocomplete, input.placeholder].join(" ");
      return input instanceof HTMLInputElement &&
        !["hidden", "checkbox", "submit", "button"].includes(input.type) &&
        (/otp|one-time|auth.?code|certification/i.test(hint) || input.maxLength === 6);
    });
  };

  const findRememberOtpCheckbox = () => {
    const explicit = document.getElementById("STORE_OTP_AUTH_RESULT") ||
      document.querySelector('input[name="STORE_OTP_AUTH_RESULT"]');
    if (explicit instanceof HTMLInputElement && explicit.type === "checkbox") return explicit;

    return [...document.querySelectorAll('input[type="checkbox"]')].find((input) => {
      const label = input.closest("label")?.textContent || input.parentElement?.textContent || "";
      return /30\s*日間|表示しない/.test(label);
    });
  };

  const findOtpSubmitButton = () => {
    const cleTotpSubmit = document.getElementById("totp-submit-button");
    if (cleTotpSubmit instanceof HTMLElement && /送信|submit/i.test(visibleText(cleTotpSubmit))) return cleTotpSubmit;

    const explicit = document.querySelector('.Btn1Def[type="submit"], input.Btn1Def, button.Btn1Def');
    if (explicit instanceof HTMLElement && /認証|確認/.test(visibleText(explicit))) return explicit;

    return [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')].find((button) => {
      if (button.classList.contains("autofill-floating-btn")) return false;
      return /認証|確認|送信|submit/i.test(visibleText(button));
    });
  };

  if (location.origin === CLE_ORIGIN) {
    const samlButton = document.getElementById("loginsaml");
    if (samlButton instanceof HTMLElement &&
        /大阪大学個人IDを持っている方/.test(visibleText(samlButton))) {
      chrome.runtime.sendMessage({ type: "auth-auto-login-state" }).then((response) => {
        if (!response?.ok || !response.enabled || !response.autoSubmit) return;
        samlButton.click();
      });
      return;
    }

    const cleIdInput = document.getElementById("user_id") || document.querySelector('input[name="user_id"]');
    const clePasswordInput = document.getElementById("password") || document.querySelector('input[name="password"]');
    const cleLoginSubmit = document.getElementById("entry-login") || document.querySelector('button[name="login"], input[name="login"]');
    if (cleIdInput instanceof HTMLInputElement &&
        clePasswordInput instanceof HTMLInputElement &&
        cleLoginSubmit instanceof HTMLElement) {
      chrome.runtime.sendMessage({ type: "auth-credentials" }).then((response) => {
        if (!response?.ok || !response.credentials) return;
        if (!credentialsMatch(cleIdInput, clePasswordInput, response.credentials)) return;
        if (!cleIdInput.value) setValue(cleIdInput, response.credentials.id);
        if (!clePasswordInput.value) setValue(clePasswordInput, response.credentials.password);
        if (response.autoSubmit) cleLoginSubmit.click();
      });
      return;
    }
  }

  const idInput = document.getElementById("USER_ID");
  const passwordInput = document.getElementById("USER_PASSWORD");
  const loginSubmit = document.querySelector('input[name="cmdForm.Submit"]');
  if (idInput instanceof HTMLInputElement &&
      passwordInput instanceof HTMLInputElement &&
      loginSubmit instanceof HTMLInputElement) {
    chrome.runtime.sendMessage({ type: "auth-credentials" }).then((response) => {
      if (!response?.ok || !response.credentials) return;
      if (!credentialsMatch(idInput, passwordInput, response.credentials)) return;
      if (!idInput.value) setValue(idInput, response.credentials.id);
      if (!passwordInput.value) setValue(passwordInput, response.credentials.password);
      if (response.autoSubmit) submitIdpLogin(loginSubmit);
    });
    return;
  }

  const pageText = `${document.title} ${document.body.textContent || ""}`;
  if (/認証コード|ワンタイムパスワード|OTP|MFA認証|Type the Code|secondaryAuthToken/i.test(pageText)) {
    const otpInput = findOtpInput();
    if (otpInput instanceof HTMLInputElement && !otpInput.value) {
      chrome.runtime.sendMessage({ type: "auth-totp" }).then((response) => {
        if (!response?.ok || !response.code || otpInput.value) return;
        setValue(otpInput, response.code);
        const remember = findRememberOtpCheckbox();
        if (remember instanceof HTMLInputElement && !remember.checked) remember.click();

        const submit = findOtpSubmitButton();
        if (response.autoSubmit && submit instanceof HTMLElement) submit.click();
      });
    }
  }

  if (location.origin === "https://auth-mfa.auth.osaka-u.ac.jp") {
    let autoCollectRegistration = Promise.resolve();
    let autoCollectPermissionBlocked = false;
    if (location.hash === "#auto-collect") {
      sessionStorage.setItem("koan-plus-mfa-auto-collect", "true");
      autoCollectRegistration = chrome.runtime.sendMessage({ type: "auth-mfa-register-auto-tab" })
        .then((response) => {
          if (response?.permissionRequired || (isFirefoxDataConsentEnv() && !response?.ok)) {
            autoCollectPermissionBlocked = true;
            sessionStorage.removeItem("koan-plus-mfa-auto-collect");
          }
          return response;
        })
        .catch(() => {
          // Firefoxでは失敗後にこのフラグを残すと次ページで自動登録が再開するため、同意を確認できない場合は破棄する。
          if (isFirefoxDataConsentEnv()) {
            autoCollectPermissionBlocked = true;
            sessionStorage.removeItem("koan-plus-mfa-auto-collect");
          }
          return undefined;
        });
      history.replaceState(null, document.title, location.pathname + location.search);
    }

    autoCollectRegistration.then(() => {
      if (autoCollectPermissionBlocked) return null;
      return chrome.runtime.sendMessage({ type: "auth-mfa-check-auto-tab" });
    }).then((response) => {
      if (autoCollectPermissionBlocked || !response) return;
      if (isFirefoxDataConsentEnv() && !response.ok) {
        sessionStorage.removeItem("koan-plus-mfa-auto-collect");
        return;
      }
      const isAutoCollect = response?.isAutoCollect === true ||
        (!isFirefoxDataConsentEnv() && sessionStorage.getItem("koan-plus-mfa-auto-collect") === "true");

      const isSuccessPage = document.body.innerText.includes("MFA登録\t：\t登録済") ||
        document.body.innerText.includes("MFA登録 ： 登録済");
      const pendingTransactionId = sessionStorage.getItem(MFA_PENDING_TRANSACTION_KEY);

      if (isSuccessPage && pendingTransactionId) {
        chrome.runtime.sendMessage({
          type: "auth-mfa-confirm-save",
          transactionId: pendingTransactionId,
        }).then((confirmRes) => {
          if (confirmRes?.ok && isAutoCollect) {
            sessionStorage.removeItem(MFA_PENDING_TRANSACTION_KEY);
            setTimeout(() => {
              chrome.runtime.sendMessage({ type: "auth-close-tab" });
            }, 1000);
          }
          if (confirmRes?.ok) sessionStorage.removeItem(MFA_PENDING_TRANSACTION_KEY);
        });
        return;
      }

      const viewIdInput = document.querySelector('input[name="viewId"]');
      const isDisplayPage = (viewIdInput instanceof HTMLInputElement && viewIdInput.value === "MfaInfoDisplay.jsp") ||
        document.body.innerText.includes("MFA情報表示");

      if (isDisplayPage && isAutoCollect) {
        const proceedBtn = [...document.querySelectorAll('input[type="button"], input[type="submit"], button')].find((btn) =>
          btn.value?.includes("MFA登録に進む") || btn.textContent?.includes("MFA登録に進む")
        );
        if (proceedBtn instanceof HTMLElement) {
          proceedMfaRegistration(proceedBtn);
          return;
        }
      }

      const isRegisterPage = (viewIdInput instanceof HTMLInputElement && viewIdInput.value === "MfaInfoRegister.jsp") ||
        document.body.innerText.includes("手動入力コード");

      if (isRegisterPage && !window.__koanPlusMfaRegisterStarted) {
        window.__koanPlusMfaRegisterStarted = true;

        const secretMatch = document.body.innerText.match(/手動入力コード\s*[：:]\s*([A-Z2-7]{16})/i);
        if (!secretMatch) return;
        const secret = secretMatch[1].toUpperCase();

        const generateRandomCode = () => {
          const array = new Uint32Array(1);
          window.crypto.getRandomValues(array);
          return String((array[0] % 90000000) + 10000000);
        };
        const cancelCode = generateRandomCode();

        chrome.runtime.sendMessage({
          type: "auth-mfa-pending-save",
          secret,
          temporaryCancelCode: cancelCode,
        }).then((saveRes) => {
          if (!saveRes?.ok || !saveRes.code || !saveRes.transactionId) return;

          const totpInput = document.querySelector('input[name="totpCode"]');
          const cancelInput = document.querySelector('input[name="temporaryCancelCode"]');
          const cancelConfirmInput = document.querySelector('input[name="temporaryCancelCodeConfirm"]');

          if (totpInput) setValue(totpInput, saveRes.code);
          if (cancelInput) setValue(cancelInput, cancelCode);
          if (cancelConfirmInput) setValue(cancelConfirmInput, cancelCode);

          showMfaNotification(cancelCode);

          const confirmBtn = [...document.querySelectorAll('input[type="button"], button')].find((btn) =>
            btn.value?.includes("確認") || btn.textContent?.includes("確認")
          );
          const registerBtn = document.getElementById("registerButton") ||
            document.querySelector('input[type="button"][value*="登録"]');

          if (isAutoCollect) {
            if (confirmBtn instanceof HTMLElement) confirmBtn.click();
            if (registerBtn instanceof HTMLElement) {
              sessionStorage.setItem(MFA_PENDING_TRANSACTION_KEY, saveRes.transactionId);
              setTimeout(() => {
                if (!isFirefoxDataConsentEnv()) {
                  registerBtn.click();
                  return;
                }
                // Consent or the registration flow may have been cancelled during the delay.
                chrome.runtime.sendMessage({ type: "auth-mfa-check-auto-tab" }).then((state) => {
                  if (state?.ok && state.isAutoCollect) registerBtn.click();
                }).catch(() => {});
              }, 1200);
            }
          } else if (registerBtn) {
            registerBtn.addEventListener("click", () => {
              sessionStorage.setItem(MFA_PENDING_TRANSACTION_KEY, saveRes.transactionId);
            });
          }
        });
      }
    }).catch(() => {});
  }

  function showMfaNotification(code) {
    if (document.getElementById("koan-plus-mfa-banner")) return;
    const banner = document.createElement("div");
    banner.id = "koan-plus-mfa-banner";
    banner.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      background: #1e293b;
      color: #f8fafc;
      padding: 16px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 100000;
      font-family: sans-serif;
      font-size: 14px;
      max-width: 320px;
      border-left: 4px solid #3b82f6;
    `;
    banner.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 8px; color: #60a5fa;">KOAN Plus 自動設定</div>
      <div style="margin-bottom: 8px; line-height: 1.4;">
        一時解除コード <strong id="koan-plus-mfa-cancel-code" style="font-size: 16px; color: #f43f5e; background: #311b22; padding: 2px 6px; border-radius: 4px;"></strong> を自動生成して入力しました。
      </div>
      <div style="font-size: 12px; color: #94a3b8; line-height: 1.4; margin-bottom: 12px;">
        登録完了後、拡張機能の設定画面からいつでもこのコードを確認・コピーできます。
      </div>
      <div style="text-align: right;">
        <button id="koan-plus-mfa-banner-close" style="
          background: #334155;
          color: #f8fafc;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        ">了解</button>
      </div>
    `;
    banner.querySelector("#koan-plus-mfa-cancel-code").textContent = String(code);
    document.body.appendChild(banner);
    document.getElementById("koan-plus-mfa-banner-close").addEventListener("click", () => {
      banner.remove();
    });
  }
})();
