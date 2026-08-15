// frontend/js/app.js — Bootstrap, event bindings, and orchestration

import {
  API_BASE_URL,
  buildClientFallbackReply,
  deleteMemory,
  deleteMemoryGraphItem,
  getCurrentUserProfile,
  loadUserProfile,
  saveMemoryGraph,
  sendChatMessageStream,
  deleteCurrentCloudChat,
  updateUserProfilePreferences,
} from "./api.js";

import {
  authIsConfigured,
  clearPhoneNumberSignIn,
  confirmPhoneNumberSignIn,
  createAccountWithEmailPassword,
  getCurrentUser,
  getAuthRedirectDiagnostic,
  getIdToken,
  getAppCheckToken,
  sendPasswordReset,
  signInWithApple,
  signInWithEmailPassword,
  signInWithGoogle,
  signOut,
  startPhoneNumberSignIn,
} from "./auth.js";

import {
  addMessage,
  appendStatusIndicator,
  finalizeStatusIndicator,
  autoResizeInput,
  clearChatMemory,
  clearInput,
  closeModal,
  escapeHtml,
  exportConversationLog,
  getState,
  initializeTheme,
  loadState,
  openModal,
  patchState,
  saveState,
  refreshIcons,
  removeStatusIndicator,
  renderWeeklyTracker,
  updateMentalHealthUI,
  replaceChatMemory,
  scrollChatToBottom,
  setButtonBusy,
  setChatStarted,
  setCloudSyncEnabled,
  setCrisisMode,
  setGreeting,
  setInputState,
  setUserName,
  showToast,
  syncInputButtons,
  updateProfileUI,
  updateUsageUI,
  updateUsageFromMeta,
  registerSettingsStore,
  getStreakSnapshot,
} from "./ui_state.js";

import { initLiveVoice, startLiveVoice } from "./voice_live.js";
import { emitNeuralEvent, emitSafeModeRuntimeTrace } from "./neural_telemetry.js";

import {
  formatMarkdown,
  sanitizeRichHtml,
  stripMarkdown,
  typewriteHTML,
  bindAccordion,
} from "./utils/dom.js";

import { processStructuredResponse, truncateRepetition, extractVisibleText } from "./utils/chat_helpers.js";
import { speakText, fallbackCopy, isSafetyLock, isCrisisReply, resolveLocale } from "./utils/tts.js";
import { resolveVoiceCallSummaryState } from "./utils/voice_summary.js";

import {
  applyVisualSettings,
  buildChatSettingsMetadata,
  getAppSettings,
  hydrateSettingsFromProfile,
  setAppSetting,
} from "./settings_store.js";

import {
  initSettingsUI,
  bindSettingsControls,
  bindSettingsChoiceEvents,
  bindKeyboardShortcuts,
  persistAppSettingsToCloud,
  notifyFromSetting,
  renderSettingsControls,
} from "./components/settings_ui.js";

import {
  initMemoryUI,
  renderMemoryInspector,
} from "./components/memory_inspector.js";

import {
  bindUnifiedSelector,
  getCurrentModel,
  getCurrentMode,
} from "./components/model_selector.js";

import {
  initNotifications,
  notifyResponseComplete,
} from "./components/notifications.js";

import {
  initUsageTracker,
  canSendMessage,
  recordMessage,
  syncFromBackend as syncUsageFromBackend,
  renderUsagePanel,
} from "./components/usage_tracker.js";

import {
  initFrontendAuth,
  cleanupAuth,
  hydrateCloudMemory,
  hydrateCloudChat,
  scheduleCloudMessageSync,
  replaceCloudChatSnapshotSafe,
  persistMemoryContextSafe,
  buildCloudProfileContext,
  formatCloudConnectErrorSafe,
  resetCloudState,
  setMemoryContext,
  getMemoryGraphContext,
  setMemoryGraphContext,
  getCurrentCloudProfileContext,
  setCurrentCloudProfileContext,
  setCloudConnectInProgress,
} from "./cloud_sync.js";

import {
  classifyAndStoreMemoryGraphFromMessage,
  createEmptyMemoryGraph,
  buildMemoryGraphLines,
  loadMemoryGraphContext,
  memoryGraphFromBackend,
  mergeMemoryGraphs,
  replaceMemoryGraphAtomValue,
  saveMemoryGraphContext,
} from "./memory_graph.js";

import { memoryFromBackendSummary } from "./memory_graph.js";

// ═══════════════════════════════════════════════════════════════
// App state
// ═══════════════════════════════════════════════════════════════

let isGenerating = false;
let isSessionLocked = false;
let activeStreamController = null;

let globalLoaderRemoved = false;
export function removeGlobalLoader() {
  if (globalLoaderRemoved) return;
  globalLoaderRemoved = true;
  // Cancel the HTML safety-net timer
  if (window.__mindpalLoaderTimer) {
    clearTimeout(window.__mindpalLoaderTimer);
    window.__mindpalLoaderTimer = null;
  }
  const loader = document.getElementById("global-loader");
  if (loader) {
    setTimeout(() => {
      loader.classList.add("opacity-0");
      setTimeout(() => loader.remove(), 700);
    }, 150);
  }
}

// ═══════════════════════════════════════════════════════════════
// Voice context provider
// ═══════════════════════════════════════════════════════════════

function buildVoiceContextProvider() {
  return {
    getUserProfile() {
      const user = getCurrentUser?.() || {};
      const graph = getMemoryGraphContext();
      const activeAtoms = (graph?.atoms || []).filter((atom) => atom.status === "active");
      const preferredName = activeAtoms.find((atom) => atom.category === "profile" && atom.metadata?.field === "preferred_name")?.value || "";
      const preferenceValues = activeAtoms.filter((atom) => atom.category === "preferences").map((atom) => atom.value);
      const avoidValues = activeAtoms.filter((atom) => atom.category === "avoid").map((atom) => atom.value);
      const patternValues = activeAtoms.filter((atom) => atom.category === "patterns").map((atom) => atom.value);
      const goalValues = activeAtoms.filter((atom) => atom.category === "goals").map((atom) => atom.value);
      const name = user?.displayName || user?.name || preferredName || "";

      const genderAtom = activeAtoms.find((atom) =>
        ["profile", "facts"].includes(atom.category)
        && /\b(male|female|boy|girl|man|woman|ذكر|انثى|أنثى|ولد|بنت|راجل|ست)\b/i.test(atom.value || "")
      );
      let gender = "";
      if (genderAtom) {
        const value = String(genderAtom.value || "").toLowerCase();
        if (/\b(male|boy|man|ذكر|ولد|راجل)\b/i.test(value)) gender = "male";
        else if (/\b(female|girl|woman|انثى|أنثى|بنت|ست)\b/i.test(value)) gender = "female";
      }

      const tone = preferenceValues.find((value) => /\b(direct|gentle|casual|formal|warm|empathetic)\b/i.test(value)) || "";
      const language = preferenceValues.find((value) => /\b(arabic|english|french|spanish|عربي|انجليزي|إنجليزي)\b/i.test(value)) || "";

      return {
        name,
        gender,
        preferences: {
          tone,
          language,
          responseStyle: preferenceValues,
          avoid: avoidValues,
        },
        communication: {
          avoidedResponses: avoidValues,
          emotionalTriggers: patternValues,
          userGoals: goalValues,
        },
      };
    },
    getMemoryLines() {
      return buildMemoryGraphLines(getMemoryGraphContext()).slice(0, 30);
    },
    getRecentChat(count = 10) {
      const messages = getState().chatMemory || [];
      return messages.slice(-Math.min(count, 20));
    },
    searchChat(query) {
      const messages = getState().chatMemory || [];
      const q = String(query || "").toLowerCase();
      return messages.filter((message) => String(message.text || "").toLowerCase().includes(q));
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Console banner
// ═══════════════════════════════════════════════════════════════

const consoleBanner = `
 __  __ _           _ ____       _ 
|  \\/  (_)_ __   __| |  _ \\ __ _| |
| |\\/| | | '_ \\ / _\` | |_) / _\` | |
| |  | | | | | | (_| |  __/ (_| | |
|_|  |_|_|_| |_|\\__,_|_|   \\__,_|_|
                                   
Welcome to the MindPal developer console!

⚠️ WARNING: This is a browser feature intended for developers.
If someone told you to copy-paste something here to enable a feature
or "hack" someone's account, it is a scam and will give them access
to your MindPal account.
`;
console.log("%c" + consoleBanner, "color: #3b82f6; font-weight: bold; font-family: monospace;");

// ═══════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  try {
    refreshIcons();
    initializeTheme();
    registerSettingsStore({ setAppSetting });
    applyVisualSettings();
    loadState();

    await initFrontendAuth({
      removeGlobalLoader,
      renderPersistedChat,
      renderMemoryInspector,
    });

    initSettingsUI({
      refreshIcons,
      showToast,
      openModal,
      closeModal,
      startNewLocalChat,
      handleSend: () => handleSend(),
      getCurrentUser,
      updateProfileUI,
      get isGenerating() { return isGenerating; },
      get isSessionLocked() { return isSessionLocked; },
      get currentCloudProfileContext() { return getCurrentCloudProfileContext(); },
    });

    initMemoryUI({
      refreshIcons,
      deleteMemoryEntry,
      editMemoryEntry,
      toggleMemoryPin,
      clearMemoryCategory,
      persistMemoryContextSafe,
      getMemoryGraphContext,
    });

    bindTheme();
    bindProfileModal();
    bindAuthModal();
    bindSettingsTabs();
    bindSettingsControls();
    bindSettingsChoiceEvents();
    bindKeyboardShortcuts();
    bindStreakModal();
    bindSettings();
    bindInput();
    bindUnifiedSelector({ isSessionLocked: () => isSessionLocked, isGenerating: () => isGenerating });
    bindMoodButtons();
    bindConversationActions();

    initNotifications({ showToast, getStreakSnapshot });
    initUsageTracker({ showToast });

    initLiveVoice({
      onChatSync: (callData) => {
        const { userTranscript, aiTranscript, startTime, endTime, durationMs } = callData;
        if (!userTranscript && !aiTranscript) return;

        const totalSec = Math.round(durationMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

        const callMsg = addMessage("MindPal", `[Voice Call] ${durationStr}`, {
          type: "voice_call",
          voiceCall: { startTime, endTime, durationMs, durationStr, userTranscript, aiTranscript },
        });

        if (callMsg) {
          setChatStarted(true);
          insertCallCardUI({ startTime, durationStr, userTranscript, aiTranscript });
        }

        if (userTranscript) {
          const graphResult = classifyAndStoreMemoryGraphFromMessage(userTranscript, {
            graphContext: getMemoryGraphContext(),
            source: "voice_call",
          });
          const canonicalGraph = saveMemoryGraphContext(graphResult.graph);
          setMemoryGraphContext(canonicalGraph);
          setMemoryContext(canonicalGraph);
          if (graphResult.saved.length) {
            renderMemoryInspector();
            void persistMemoryContextSafe();
          }
        }

        scrollChatToBottom("smooth", true);
      },
    });

    const mainVoiceBtn = document.getElementById("voice-btn");
    if (mainVoiceBtn) {
      mainVoiceBtn.addEventListener("click", () => {
        if (isGenerating || isSessionLocked) return;
        startLiveVoice(buildVoiceContextProvider());
      });
    }

    renderPersistedChat();
    updateProfileUI(getCurrentUser());
    setGreeting();
    setInputState({ disabled: false, locked: false });

    updateMentalHealthUI();
    renderWeeklyTracker();

    refreshIcons();

    if (!authIsConfigured()) {
      removeGlobalLoader();
    }
  } catch (error) {
    console.error("[MindPal] Bootstrap failed:", error);
    if (typeof showToast === 'function') {
      showToast("Critical error during startup. Please refresh the page.");
    }
    removeGlobalLoader();
  }
}

// ═══════════════════════════════════════════════════════════════
// Event bindings
// ═══════════════════════════════════════════════════════════════

function bindTheme() {
  document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
    const isDark = document.documentElement.classList.contains("dark");
    setAppSetting("appearance", isDark ? "light" : "dark");
    void persistAppSettingsToCloud();
  });
}

function formatAuthModalError(error) {
  const code = String(error?.code || "");
  if (code.includes("invalid-credential") || code.includes("wrong-password")) return "That email or password is not correct.";
  if (code.includes("user-not-found")) return "No MindPal account exists for that email yet.";
  if (code.includes("email-already-in-use")) return "An account already exists for that email. Try signing in instead.";
  if (code.includes("weak-password")) return "Use a password with at least 6 characters.";
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait a moment and try again.";
  if (code.includes("invalid-phone-number")) return "Enter a complete mobile number with its country code.";
  if (code.includes("invalid-verification-code")) return "That verification code is not correct. Try again or request a new one.";
  if (code.includes("code-expired") || code.includes("session-expired")) return "That verification code expired. Request a new one.";
  if (code.includes("operation-not-allowed")) return "This sign-in method needs to be completed in Firebase before it can be used.";
  return formatCloudConnectErrorSafe(error);
}

async function completeCloudConnection(user) {
  if (!user) return;
  if (user.displayName) setUserName(user.displayName);

  const token = await getIdToken({ forceRefresh: true });
  if (!token) throw new Error("Firebase returned no ID token.");

  const profile = await getCurrentUserProfile(token);
  const storedProfile = await loadUserProfile(token).catch(() => null);
  if (storedProfile) {
    hydrateSettingsFromProfile(storedProfile);
    updateMentalHealthUI(storedProfile);
    updateUsageUI(storedProfile);
  }

  setCurrentCloudProfileContext({
    ...buildCloudProfileContext(user, profile),
    settingsMetadata: buildChatSettingsMetadata(),
  });
  await persistAppSettingsToCloud();
  await hydrateCloudMemory(token, renderMemoryInspector);
  await hydrateCloudChat(token, renderPersistedChat);

  setCloudSyncEnabled(true);
  updateProfileUI(user);
}

function bindAuthModal() {
  const modal = document.getElementById("auth-modal");
  const content = document.getElementById("auth-modal-content");
  const backdrop = document.getElementById("auth-modal-backdrop");
  const closeButton = document.getElementById("auth-modal-close-btn");
  const choiceView = document.getElementById("auth-view-choice");
  const emailForm = document.getElementById("auth-email-form");
  const phoneForm = document.getElementById("auth-phone-form");
  const phoneCodeForm = document.getElementById("auth-phone-code-form");
  const message = document.getElementById("auth-modal-message");
  const title = document.getElementById("auth-modal-title");
  const description = document.getElementById("auth-modal-description");
  const emailInput = document.getElementById("auth-email-input");
  const passwordInput = document.getElementById("auth-password-input");
  const passwordVisibilityButton = document.getElementById("auth-password-visibility-btn");
  const emailModeButton = document.getElementById("auth-email-mode-btn");
  const emailModeCopy = document.getElementById("auth-email-mode-copy");
  const emailSubmitButton = document.getElementById("auth-email-submit-btn");
  const passwordResetButton = document.getElementById("auth-password-reset-btn");
  const emailViewButton = document.getElementById("auth-email-view-btn");
  const phoneButton = document.getElementById("auth-phone-btn");
  const phoneInput = document.getElementById("auth-phone-input");
  const phoneRecaptcha = document.getElementById("auth-phone-recaptcha");
  const phoneSubmitButton = document.getElementById("auth-phone-submit-btn");
  const phoneCodeInput = document.getElementById("auth-phone-code-input");
  const phoneCodeSubmitButton = document.getElementById("auth-phone-code-submit-btn");
  const phoneCodeCopy = document.getElementById("auth-phone-code-copy");
  const phoneResendButton = document.getElementById("auth-phone-resend-btn");
  const googleButton = document.getElementById("auth-google-btn");
  const appleButton = document.getElementById("auth-apple-btn");
  const profileConnectButton = document.getElementById("btn-cloud-connect");
  const providerButtons = Array.from(document.querySelectorAll("[data-auth-provider]"));
  const views = [choiceView, emailForm, phoneForm, phoneCodeForm].filter(Boolean);
  let emailMode = "signin";
  let returnFocus = null;

  if (!modal || !content || !choiceView || !emailForm || !phoneForm || !phoneCodeForm) return;

  const showMessage = (text, { error = false } = {}) => {
    if (!message) return;
    message.textContent = text;
    message.classList.remove("hidden", "auth-modal__message--error");
    message.classList.toggle("auth-modal__message--error", error);
  };

  const clearMessage = () => {
    message?.classList.add("hidden");
    message?.classList.remove("auth-modal__message--error");
    if (message) message.textContent = "";
  };

  const getLastUsedProvider = () => {
    try {
      const stored = String(window.localStorage?.getItem("mindpal.auth.last-used-provider.v1") || "");
      if (["google", "apple", "phone", "email"].includes(stored)) return stored;
    } catch {}

    const providerIds = new Set((getCurrentUser()?.providerData || []).map((provider) => provider?.providerId));
    if (providerIds.has("google.com")) return "google";
    if (providerIds.has("apple.com")) return "apple";
    if (providerIds.has("phone")) return "phone";
    if (providerIds.has("password")) return "email";
    return "";
  };

  const refreshLastUsedProvider = () => {
    const lastUsedProvider = getLastUsedProvider();
    providerButtons.forEach((button) => {
      const isLastUsed = button.dataset.authProvider === lastUsedProvider;
      button.classList.toggle("auth-provider-btn--last-used", isLastUsed);
      button.querySelector("[data-auth-last-used]")?.classList.toggle("hidden", !isLastUsed);
    });
  };

  const rememberLastUsedProvider = (provider) => {
    if (!["google", "apple", "phone", "email"].includes(provider)) return;
    try { window.localStorage?.setItem("mindpal.auth.last-used-provider.v1", provider); } catch {}
    refreshLastUsedProvider();
  };

  const setView = (nextView) => {
    views.forEach((view) => view.classList.toggle("hidden", view !== nextView));
    clearMessage();
    if (nextView === choiceView) {
      title.textContent = "Back up your MindPal";
      description.textContent = "Sign in to securely sync your memory and conversations across devices.";
    } else if (nextView === emailForm) {
      title.textContent = emailMode === "signup" ? "Create your MindPal" : "Welcome back";
      description.textContent = emailMode === "signup" ? "Create a secure cloud account in a few seconds." : "Sign in to sync your memory and conversations.";
      window.setTimeout(() => emailInput?.focus(), 0);
    } else if (nextView === phoneForm) {
      title.textContent = "Verify your number";
      description.textContent = "Use your phone number to securely connect MindPal Cloud.";
      window.setTimeout(() => document.getElementById("auth-phone-input")?.focus(), 0);
    } else {
      title.textContent = "Check your messages";
      description.textContent = "Enter the one-time code to finish signing in.";
      window.setTimeout(() => document.getElementById("auth-phone-code-input")?.focus(), 0);
    }
  };

  const openAuthModal = () => {
    if (!authIsConfigured()) {
      showToast("Firebase web config is missing.");
      return;
    }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : profileConnectButton;
    emailMode = "signin";
    if (emailInput) emailInput.value = "";
    if (passwordInput) passwordInput.value = "";
    if (passwordInput) passwordInput.type = "password";
    emailForm.reset();
    clearPhoneNumberSignIn();
    phoneForm.reset();
    phoneCodeForm.reset();
    updateEmailMode();
    refreshLastUsedProvider();
    setView(choiceView);
    openModal("auth-modal", "auth-modal-content");
    modal.setAttribute("aria-hidden", "false");
    refreshIcons();
    window.setTimeout(() => content.focus(), 0);
  };

  const closeAuthModal = () => {
    closeModal("auth-modal", "auth-modal-content");
    modal.setAttribute("aria-hidden", "true");
    clearPhoneNumberSignIn();
    clearMessage();
    if (returnFocus && typeof returnFocus.focus === "function") {
      window.setTimeout(() => returnFocus.focus(), 0);
    }
  };

  const updateEmailMode = () => {
    const isSignUp = emailMode === "signup";
    if (emailModeCopy) emailModeCopy.textContent = isSignUp ? "Create a password to keep your MindPal private." : "Use your MindPal email and password to sign in.";
    if (emailSubmitButton) emailSubmitButton.textContent = isSignUp ? "Create account" : "Sign in";
    if (emailModeButton) emailModeButton.textContent = isSignUp ? "I already have an account" : "Create an account";
    if (passwordInput) passwordInput.autocomplete = isSignUp ? "new-password" : "current-password";
  };

  const connectUser = async (runSignIn, triggerButton, busyLabel, provider = "") => {
    if (!authIsConfigured()) {
      showMessage("Firebase web config is missing.", { error: true });
      return;
    }

    setButtonBusy(triggerButton, true, busyLabel);
    setCloudConnectInProgress(true);
    try {
      const user = await runSignIn();
      if (!user) {
        throw new Error("Firebase did not return a signed-in user.");
      }
      await completeCloudConnection(user);
      rememberLastUsedProvider(provider);
      closeAuthModal();
      showToast("Cloud profile connected.");
    } catch (error) {
      setCloudSyncEnabled(false);
      updateProfileUI(null);
      showMessage(formatAuthModalError(error), { error: true });
    } finally {
      setCloudConnectInProgress(false);
      setButtonBusy(triggerButton, false);
    }
  };

  profileConnectButton?.addEventListener("click", openAuthModal);
  closeButton?.addEventListener("click", closeAuthModal);
  backdrop?.addEventListener("click", closeAuthModal);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("opacity-0")) closeAuthModal();
  });

  emailViewButton?.addEventListener("click", () => setView(emailForm));
  phoneButton?.addEventListener("click", () => setView(phoneForm));
  document.querySelectorAll("[data-auth-back]").forEach((button) => button.addEventListener("click", () => {
    clearPhoneNumberSignIn();
    setView(choiceView);
  }));

  passwordVisibilityButton?.addEventListener("click", () => {
    if (!passwordInput) return;
    const showPassword = passwordInput.type === "password";
    passwordInput.type = showPassword ? "text" : "password";
    passwordVisibilityButton.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
    passwordVisibilityButton.innerHTML = `<i data-lucide="${showPassword ? "eye-off" : "eye"}" class="w-4 h-4"></i>`;
    refreshIcons();
  });

  emailModeButton?.addEventListener("click", () => {
    emailMode = emailMode === "signin" ? "signup" : "signin";
    updateEmailMode();
    clearMessage();
  });

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = String(emailInput?.value || "").trim();
    const password = String(passwordInput?.value || "");
    if (!emailInput?.checkValidity()) {
      showMessage("Enter a valid email address.", { error: true });
      emailInput?.focus();
      return;
    }
    if (password.length < 6) {
      showMessage("Use a password with at least 6 characters.", { error: true });
      passwordInput?.focus();
      return;
    }
    await connectUser(
      () => emailMode === "signup" ? createAccountWithEmailPassword(email, password) : signInWithEmailPassword(email, password),
      emailSubmitButton,
      emailMode === "signup" ? "Creating account..." : "Signing in...",
      "email",
    );
  });

  passwordResetButton?.addEventListener("click", async () => {
    const email = String(emailInput?.value || "").trim();
    if (!emailInput?.checkValidity()) {
      showMessage("Enter your email address, then select password reset.", { error: true });
      emailInput?.focus();
      return;
    }
    setButtonBusy(passwordResetButton, true, "Sending...");
    try {
      await sendPasswordReset(email);
      showMessage("If that email has a MindPal account, a password-reset message is on its way.");
    } catch (error) {
      showMessage(formatAuthModalError(error), { error: true });
    } finally {
      setButtonBusy(passwordResetButton, false);
    }
  });

  phoneForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const phoneNumber = String(phoneInput?.value || "").trim();
    if (!phoneInput?.checkValidity()) {
      showMessage("Enter your mobile number with country code.", { error: true });
      phoneInput?.focus();
      return;
    }

    setButtonBusy(phoneSubmitButton, true, "Sending code...");
    clearMessage();
    try {
      await startPhoneNumberSignIn(phoneNumber, phoneRecaptcha);
      if (phoneCodeCopy) phoneCodeCopy.textContent = `Enter the 6-digit code sent to ${phoneNumber}.`;
      setView(phoneCodeForm);
    } catch (error) {
      showMessage(formatAuthModalError(error), { error: true });
    } finally {
      setButtonBusy(phoneSubmitButton, false);
    }
  });

  phoneCodeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = String(phoneCodeInput?.value || "").trim();
    if (!/^\d{6}$/.test(code)) {
      showMessage("Enter the 6-digit verification code.", { error: true });
      phoneCodeInput?.focus();
      return;
    }
    await connectUser(() => confirmPhoneNumberSignIn(code), phoneCodeSubmitButton, "Verifying...", "phone");
  });

  phoneResendButton?.addEventListener("click", () => {
    setView(phoneForm);
    phoneForm.requestSubmit();
  });

  googleButton?.addEventListener("click", () => connectUser(signInWithGoogle, googleButton, "Opening Google...", "google"));
  appleButton?.addEventListener("click", () => connectUser(signInWithApple, appleButton, "Opening Apple...", "apple"));
}

function bindProfileModal() {
  const profileModal = document.getElementById("profile-modal");
  const closeProfileBtn = document.getElementById("close-profile-btn");
  const closeProfileMobileBtn = document.getElementById("close-profile-mobile-btn");
  const connectBtn = document.getElementById("btn-cloud-connect");
  const disconnectBtn = document.getElementById("btn-cloud-disconnect");
  const userNameInput = document.getElementById("user-name-input");
  const authDiagnostic = document.getElementById("account-auth-diagnostic");

  const refreshAuthDiagnostic = () => {
    if (!authDiagnostic) return;
    const diagnostic = getAuthRedirectDiagnostic();
    const provider = diagnostic.provider || "Provider";
    let message = "";

    if (diagnostic.status === "no_credential") {
      message = `${provider} returned to MindPal, but Firebase did not restore a sign-in credential. Please retry after checking the auth callback configuration.`;
    } else if (diagnostic.status === "failed") {
      const reason = diagnostic.detail ? ` Firebase reason: ${diagnostic.detail}.` : "";
      message = `${provider} sign-in could not finish: ${diagnostic.code || "firebase_sign_in_failed"}.${reason}`;
    }

    authDiagnostic.textContent = message;
    authDiagnostic.classList.toggle("hidden", !message);
  };

  document.getElementById("profile-btn")?.addEventListener("click", () => {
    updateProfileUI(getCurrentUser());
    refreshAuthDiagnostic();
    // Re-render settings controls so dropdowns reflect changes made outside the panel
    renderSettingsControls(document.getElementById("profile-content") || document);
    if (document.querySelector('[data-settings-panel="memory"]')?.classList.contains("active")) {
      renderMemoryInspector();
    }
    openModal("profile-modal", "profile-content");
  });

  closeProfileBtn?.addEventListener("click", () => closeModal("profile-modal", "profile-content"));
  closeProfileMobileBtn?.addEventListener("click", () => closeModal("profile-modal", "profile-content"));

  profileModal?.addEventListener("click", (event) => {
    if (event.target === profileModal) closeProfileBtn?.click();
  });

  disconnectBtn?.addEventListener("click", async () => {
    try { await signOut(); } catch {}
    resetCloudState();
    setCloudSyncEnabled(false);
    updateProfileUI(null);
    showToast("Signed out. Local mode enabled.");
  });

  userNameInput?.addEventListener("change", (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : userNameInput;
    const nextName = setUserName(input?.value || "");
    let memoryGraphContext = getMemoryGraphContext();

    if (nextName !== "Friend") {
      const result = classifyAndStoreMemoryGraphFromMessage(`remember: my name is ${nextName}`, {
        graphContext: memoryGraphContext,
        source: "profile",
      });
      memoryGraphContext = result.graph;
    } else {
      const now = new Date().toISOString();
      memoryGraphContext = {
        ...memoryGraphContext,
        atoms: (memoryGraphContext.atoms || []).map((atom) =>
          atom.category === "profile" && atom.metadata?.field === "preferred_name"
            ? { ...atom, status: "deleted", pinned: false, updated_at: now, metadata: { ...(atom.metadata || {}), deleted_by_user: true } }
            : atom,
        ),
      };
    }

    const canonicalGraph = saveMemoryGraphContext(memoryGraphContext);
    setMemoryGraphContext(canonicalGraph);
    setMemoryContext(canonicalGraph);
    void persistMemoryContextSafe();
    
    getIdToken().then(token => {
      if (token) {
        updateUserProfilePreferences({ preferred_name: nextName === "Friend" ? "" : nextName }, token).catch(e => {
          console.warn("Failed to sync profile name:", e);
        });
      }
    }).catch(() => {});

    renderMemoryInspector();
    updateProfileUI(getCurrentUser());
    showToast(nextName === "Friend" ? "Profile name cleared." : "Profile updated.");
  });

  document.getElementById("delete-account-btn")?.addEventListener("click", async () => {
    const user = getCurrentUser();
    if (!user) { showToast("No cloud account is connected."); return; }

    const confirmed = await showCustomDialog({
      title: "Delete account",
      message: `This will permanently remove your cloud identity (${user.email || "unknown"}) and all synced data. This cannot be undone.`,
      confirmText: "Delete account",
      danger: true,
    });
    if (!confirmed) return;

    try {
      const token = await getIdToken();
      if (token) {
        await deleteMemory(token);
        await saveMemoryGraph(createEmptyMemoryGraph(), token);
        await deleteCurrentCloudChat(token);
      }
      await signOut();
    } catch (error) {
      console.warn("Account deletion failed:", error);
    }

    resetCloudState();
    clearChatMemory();
    const emptyGraph = saveMemoryGraphContext(createEmptyMemoryGraph());
    setMemoryGraphContext(emptyGraph);
    setMemoryContext(emptyGraph);
    renderMemoryInspector();
    document.getElementById("chat-history")?.replaceChildren();
    setChatStarted(false);
    setCloudSyncEnabled(false);
    updateProfileUI(null);
    closeModal("profile-modal", "profile-content");
    showToast("Account deleted and signed out.");
  });
}

function bindStreakModal() {
  const streakModal = document.getElementById("streak-modal");
  const closeStreakBtn = document.getElementById("close-streak-btn");

  document.getElementById("streak-btn")?.addEventListener("click", () => {
    renderWeeklyTracker();
    openModal("streak-modal", "streak-content");
  });

  closeStreakBtn?.addEventListener("click", () => closeModal("streak-modal", "streak-content"));

  streakModal?.addEventListener("click", (event) => {
    if (event.target === streakModal) closeStreakBtn?.click();
  });
}

function bindSettings() {
  document.getElementById("crisis-toggle")?.addEventListener("change", (event) => {
    setCrisisMode(event.target.checked);
    showToast(
      event.target.checked
        ? "Crisis UI interception enabled. Backend safety is always active."
        : "Crisis UI interception disabled. Backend safety is still active.",
    );
  });

  document.getElementById("memory-refresh-btn")?.addEventListener("click", async () => {
    const token = await getIdToken();
    if (token) {
      await hydrateCloudMemory(token, renderMemoryInspector);
      showToast("Memory refreshed.");
      return;
    }
    const localGraph = loadMemoryGraphContext();
    setMemoryGraphContext(localGraph);
    setMemoryContext(localGraph);
    renderMemoryInspector();
    showToast("Local memory refreshed.");
  });
}

function bindSettingsTabs() {
  const buttons = Array.from(document.querySelectorAll("[data-settings-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-settings-panel]"));
  const mobileSelect = document.getElementById("settings-mobile-tabs");

  const activate = (tab) => {
    const nextTab = tab || "general";
    buttons.forEach((button) => button.classList.toggle("active", button.getAttribute("data-settings-tab") === nextTab));
    panels.forEach((panel) => {
      const isActive = panel.getAttribute("data-settings-panel") === nextTab;
      panel.classList.toggle("active", isActive);
      panel.hidden = !isActive;
    });
    if (mobileSelect && mobileSelect.value !== nextTab) mobileSelect.value = nextTab;
    if (nextTab === "memory") renderMemoryInspector();
    if (nextTab === "usage") renderUsagePanel();
  };

  buttons.forEach((button) => button.addEventListener("click", () => activate(button.getAttribute("data-settings-tab") || "general")));
  mobileSelect?.addEventListener("change", (event) => activate(event.target.value));
  activate("general");
}

function startNewLocalChat() {
  if (activeStreamController) {
    activeStreamController.abort();
    activeStreamController = null;
  }
  isGenerating = false;

  clearChatMemory();
  document.getElementById("chat-history")?.replaceChildren();
  clearInput();
  setChatStarted(false);
  isSessionLocked = false;
  setInputState({ disabled: false, locked: false });
  showToast("New conversation started.");

  if (getCurrentUser()) {
    void replaceCloudChatSnapshotSafe([]);
  }
}

function bindInput() {
  const inputEl = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");

  inputEl?.addEventListener("input", () => {
    autoResizeInput();
    syncInputButtons();
  });

  inputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!isGenerating && !isSessionLocked) handleSend().catch(console.error);
    }
  });

  sendBtn?.addEventListener("click", () => {
    if (!isGenerating && !isSessionLocked) handleSend().catch(console.error);
  });
}

function bindMoodButtons() {
  document.querySelectorAll(".mood-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (isSessionLocked || isGenerating) return;

      const mood = String(button.getAttribute("data-mood") || "").toLowerCase();
      const inputEl = document.getElementById("chat-input");
      if (!inputEl || !mood) return;

      inputEl.value = `I'm feeling ${mood} right now.`;
      inputEl.dispatchEvent(new Event("input"));
      handleSend().catch(console.error);
    });
  });
}

function bindConversationActions() {
  document.getElementById("export-chat-btn")?.addEventListener("click", () => exportConversationLog());

  document.getElementById("clear-chat-btn")?.addEventListener("click", async () => {
    const confirmed = await showCustomDialog({
      title: "Delete all chats and memory",
      message: "This will clear your local conversation cache and cloud memory if signed in. This action cannot be undone.",
      confirmText: "Delete all",
      danger: true,
    });
    if (!confirmed) return;

    try {
      const token = await getIdToken();
      if (token) {
        await deleteMemory(token);
        await saveMemoryGraph(createEmptyMemoryGraph(), token);
        await deleteCurrentCloudChat(token);
      }
    } catch {}

    // Clear primary state
    clearChatMemory();
    const emptyGraph = saveMemoryGraphContext(createEmptyMemoryGraph());
    setMemoryGraphContext(emptyGraph);
    setMemoryContext(emptyGraph);

    // Comprehensive localStorage wipe — remove ALL mindpal-related keys
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("mindpal_")) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    } catch {}

    // Clear sessionStorage (pro confirmation etc.)
    try {
      const sessionKeysToRemove = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith("mindpal_")) {
          sessionKeysToRemove.push(key);
        }
      }
      sessionKeysToRemove.forEach((key) => sessionStorage.removeItem(key));
    } catch {}

    renderMemoryInspector();
    document.getElementById("chat-history")?.replaceChildren();
    setChatStarted(false);
    showToast("All data cleared.");
  });
}

// ═══════════════════════════════════════════════════════════════
// Memory helpers
// ═══════════════════════════════════════════════════════════════

async function deleteMemoryEntry(atomId) {
  if (!atomId) return;

  const confirmed = await showCustomDialog({
    title: "Delete memory",
    message: "Are you sure you want to delete this memory? This cannot be undone.",
    confirmText: "Delete",
    danger: true,
  });
  if (!confirmed) return;

  let memoryGraphContext = getMemoryGraphContext();
  const now = new Date().toISOString();
  memoryGraphContext.atoms = (memoryGraphContext.atoms || []).map((atom) =>
    atom.id === atomId
      ? { ...atom, status: "deleted", pinned: false, updated_at: now, metadata: { ...(atom.metadata || {}), deleted_by_user: true } }
      : atom,
  );
  setMemoryGraphContext(memoryGraphContext);
  saveMemoryGraphContext(memoryGraphContext);

  const token = await getIdToken();
  if (token) {
    await deleteMemoryGraphItem(atomId, token).catch(() => {});
  }

  showToast("Memory entry deleted.");
}

function showCustomDialog({ title = "Confirm", message = "", input = false, defaultValue = "", confirmText = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm";
    overlay.style.animation = "fadeIn 0.2s ease";

    const dangerClasses = danger
      ? "bg-rose-600 hover:bg-rose-700 text-white"
      : "bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100";

    overlay.innerHTML = `
      <div class="bg-white dark:bg-[#1e1f20] rounded-2xl shadow-2xl max-w-md w-[90%] p-6" style="animation: scaleIn 0.25s ease">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">${escapeHtml(title)}</h3>
        <p class="text-sm text-gray-600 dark:text-gray-300 mb-5">${escapeHtml(message)}</p>
        ${input ? `<input id="custom-dialog-input" class="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-transparent text-gray-900 dark:text-white text-sm mb-5 focus:outline-none focus:ring-2 focus:ring-blue-500" value="${escapeHtml(defaultValue)}" autofocus>` : ""}
        <div class="flex gap-3">
          <button id="custom-dialog-cancel" class="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
          <button id="custom-dialog-confirm" class="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl transition-colors ${dangerClasses}">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector("#custom-dialog-cancel")?.addEventListener("click", () => close(false));
    overlay.querySelector("#custom-dialog-confirm")?.addEventListener("click", () => {
      if (input) {
        close(overlay.querySelector("#custom-dialog-input")?.value ?? defaultValue);
      } else {
        close(true);
      }
    });
  });
}

async function editMemoryEntry(atomId) {
  if (!atomId) return;
  let memoryGraphContext = getMemoryGraphContext();
  const atom = (memoryGraphContext.atoms || []).find((a) => a.id === atomId);
  if (!atom) { showToast("Memory entry not found."); return; }

  const newValue = await showCustomDialog({
    title: "Edit memory",
    message: `Editing: ${atom.value || ""}`,
    input: true,
    defaultValue: atom.value || "",
    confirmText: "Save",
  });

  if (newValue === false || newValue === null) return;

  const clean = String(newValue).trim();
  if (!clean) { showToast("Cannot save empty memory."); return; }

  memoryGraphContext = replaceMemoryGraphAtomValue(memoryGraphContext, atomId, clean);
  const canonicalGraph = saveMemoryGraphContext(memoryGraphContext);
  setMemoryGraphContext(canonicalGraph);
  setMemoryContext(canonicalGraph);
  showToast("Memory updated.");
}

function toggleMemoryPin(atomId) {
  if (!atomId) return;
  let memoryGraphContext = getMemoryGraphContext();
  memoryGraphContext.atoms = (memoryGraphContext.atoms || []).map((atom) =>
    atom.id === atomId ? { ...atom, pinned: !atom.pinned, updated_at: new Date().toISOString() } : atom,
  );
  setMemoryGraphContext(memoryGraphContext);
  saveMemoryGraphContext(memoryGraphContext);
}

function clearMemoryCategory(category) {
  if (!category) return;
  let memoryGraphContext = getMemoryGraphContext();
  const now = new Date().toISOString();
  memoryGraphContext.atoms = (memoryGraphContext.atoms || []).map((atom) =>
    atom.category === category && atom.status !== "deleted"
      ? { ...atom, status: "deleted", pinned: false, updated_at: now, metadata: { ...(atom.metadata || {}), deleted_by_user: true } }
      : atom,
  );
  setMemoryGraphContext(memoryGraphContext);
  saveMemoryGraphContext(memoryGraphContext);
  showToast("Memory category cleared.");
}

// ═══════════════════════════════════════════════════════════════
// handleSend — main chat orchestrator
// ═══════════════════════════════════════════════════════════════

function renderStreamPreview(contentBox, rawText) {
  if (!contentBox) return;
  const visible = extractVisibleText(rawText, { final: false });
  contentBox.textContent = visible;
  contentBox.style.whiteSpace = "pre-wrap";
}

function renderFinalResponse(contentBox, rawText, elapsedMs) {
  if (!contentBox) return "";
  const visible = extractVisibleText(rawText, { final: true });
  contentBox.style.whiteSpace = "";
  contentBox.innerHTML = sanitizeRichHtml(processStructuredResponse(visible, elapsedMs).finalHtml);
  return visible;
}

async function handleSend() {
  const inputEl = document.getElementById("chat-input");
  const text = inputEl?.value?.trim() || "";
  if (!text || isGenerating || isSessionLocked) return;

  // ── Pre-flight usage check — block BEFORE any API call ──
  const currentModel = getCurrentModel();
  if (!canSendMessage(currentModel)) {
    showToast("You've reached your usage limit. Please wait for it to reset.", "warning");
    return;
  }

  const priorChatHistory = [...getState().chatMemory];
  let streamController = null;

  isGenerating = true;
  emitNeuralEvent("request", { inputLength: text.length });
  setInputState({ disabled: true, locked: false });
  setChatStarted(true);

  let streamMsgDiv = null;
  const statusId = `status-${Date.now()}`;
  let streamResponseStr = "";
  let firstChunkReceived = false;

  try {
    await appendMessageToUI(text, "user", { smoothScroll: true });

    const userMessageRecord = addMessage("User", text);
    scheduleCloudMessageSync(userMessageRecord);
    clearInput();

    const graphResult = classifyAndStoreMemoryGraphFromMessage(text, {
      graphContext: getMemoryGraphContext(),
      source: "chat_extraction",
    });
    const memoryGraphContext = saveMemoryGraphContext(graphResult.graph);
    setMemoryGraphContext(memoryGraphContext);
    setMemoryContext(memoryGraphContext);

    if (graphResult.saved.length) {
      renderMemoryInspector();
      void persistMemoryContextSafe();
    }

    const chatHistory = document.getElementById("chat-history");
    streamMsgDiv = document.createElement("div");
    streamMsgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    if (chatHistory) chatHistory.appendChild(streamMsgDiv);

    appendStatusIndicator(statusId, streamMsgDiv);

    let contentBox = null;
    emitNeuralEvent("tokenize", { inputLength: text.length });
    const token = await getIdToken();
    emitNeuralEvent("attention", { inputLength: text.length });
    const mode = getCurrentMode();
    const model = currentModel;
    const contentContainer = document.createElement("div");
    contentContainer.className = "flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    contentBox = document.createElement("div");
    contentBox.className = "content-box";
    contentBox.setAttribute("dir", "auto");
    contentContainer.appendChild(contentBox);
    streamMsgDiv.appendChild(contentContainer);
    scrollChatToBottom("auto", true);
    let backendMetaFinal = null;

    let lastRenderTime = 0;
    let renderTimeout = null;
          const streamStartTime = performance.now();
      let responseRendered = false;
      emitNeuralEvent("activation", { inputLength: text.length });

      if (activeStreamController) activeStreamController.abort();
    streamController = new AbortController();
    activeStreamController = streamController;

    await sendChatMessageStream({
      message: text,
      history: priorChatHistory,
      locale: resolveLocale(getAppSettings),
      mode,
      model,
      token,
      signal: streamController.signal,
      profileContext: {
        ...(getCurrentCloudProfileContext() || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (chunkText) => {
        streamResponseStr += chunkText;

        // Finalize the "Thinking..." indicator when the response delimiter appears
        if (!firstChunkReceived) {
          const hasDelimiter = /\*{2}\s*(?:Response|Balanced\s*Reframe)\s*:?\s*\*{2}/i.test(streamResponseStr)
            || /(?:\n|^)\s*(?:Response|Balanced\s*Reframe)\s*:\s*/i.test(streamResponseStr)
            // Arabic labels: الرد (response), إعادة صياغة (reframe), الاستجابة (response)
            || /\*{2}\s*(?:الرد|الاستجابة|إعادة\s*صياغة)\s*:?\s*\*{2}/.test(streamResponseStr)
            || /(?:\n|^)\s*(?:الرد|الاستجابة|إعادة\s*صياغة)\s*:\s*/.test(streamResponseStr);
          
          // Time-based fallback: if 8+ seconds and enough content, assume thinking is done
          const elapsed = performance.now() - streamStartTime;
          if (hasDelimiter || (elapsed > 8000 && streamResponseStr.length > 200)) {
            firstChunkReceived = true;
            finalizeStatusIndicator(statusId, elapsed);
          }
        }

        const now = performance.now();
        if (now - lastRenderTime > 150) {
          lastRenderTime = now;
          if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
          renderStreamPreview(contentBox, streamResponseStr);
          scrollChatToBottom("auto");
        } else if (!renderTimeout) {
          renderTimeout = requestAnimationFrame(() => {
            renderTimeout = null;
            lastRenderTime = performance.now();
            renderStreamPreview(contentBox, streamResponseStr);
            scrollChatToBottom("auto");
          });
        }
      },
      onStatus: (status) => {
        if (status === "text_finished") emitNeuralEvent("feature_graph", { inputLength: text.length });
        if (status !== "text_finished" || responseRendered) return;
        if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
        const elapsedMs = performance.now() - streamStartTime;
        renderFinalResponse(contentBox, streamResponseStr, elapsedMs);
        responseRendered = true;
        if (!firstChunkReceived) finalizeStatusIndicator(statusId, elapsedMs);
        scrollChatToBottom("auto");
      },
      onMetadata: (meta) => {
        backendMetaFinal = meta;
        if (meta?.runtime_trace) emitSafeModeRuntimeTrace(meta.runtime_trace);
        if (meta.quota_exceeded) {
          showToast("MindPal Pro usage limit reached. Switched to Standard.", "warning");
          document.querySelector('.model-option[data-model="standard"]')?.click();
        }
        if (meta.pro_usage) updateUsageFromMeta(meta.pro_usage);
        if (meta.usage) syncUsageFromBackend(meta.usage);
      },
    });

    const publicReply = extractVisibleText(streamResponseStr, { final: true });
    const reply = truncateRepetition(publicReply) || publicReply;
    if (!reply) throw new Error("Backend returned empty public reply.");

    const elapsedMs = performance.now() - streamStartTime;
    if (!responseRendered) {
      if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
      renderFinalResponse(contentBox, streamResponseStr, elapsedMs);
      if (!firstChunkReceived) finalizeStatusIndicator(statusId, elapsedMs);
      responseRendered = true;
    }

    // Record against the model used for this request, even if the UI changes mid-stream.
    recordMessage(model);

    if (isSafetyLock(backendMetaFinal)) {
      isSessionLocked = true;
    }

    const assistantMessageRecord = addMessage("MindPal", reply, {
      requestId: backendMetaFinal?.request_id || null,
      providerUsed: backendMetaFinal?.provider_used || null,
      safety: backendMetaFinal?.safety || null,
      ragUsed: backendMetaFinal?.rag_used || [],
      memoryUpdated: Boolean(backendMetaFinal?.memory_updated),
      generationTimeMs: elapsedMs,
    });

    scheduleCloudMessageSync(assistantMessageRecord);
    handleBackendMemoryUpdates(backendMetaFinal);

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    if (isCrisisReply(reply, safetyLevel)) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
      contentContainer.querySelector(".action-buttons")?.remove();
    } else if (!contentContainer.querySelector(".action-buttons")) {
      contentContainer.appendChild(buildMessageActions(reply));
    }

    notifyResponseComplete();
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the response.");

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(streamMsgDiv);
    refreshIcons();
  } catch (error) {
    if (error?.name === "AbortError") {
      if (streamMsgDiv) streamMsgDiv.remove();
      return;
    }
    emitNeuralEvent("error", { inputLength: text.length });
    console.error("handleSend error:", error);
    if (!streamResponseStr.trim() && streamMsgDiv) streamMsgDiv.remove();
    if (!firstChunkReceived) removeStatusIndicator(statusId);

    const fallback = buildClientFallbackReply(error);
    const fallbackRecord = addMessage("MindPal", fallback, { providerUsed: "client_fallback", errorCode: error?.code || "frontend_error" });
    scheduleCloudMessageSync(fallbackRecord);

    try {
      await appendMessageToUI(fallback, "bot", { smoothScroll: true, typewriter: true });
    } catch (renderError) {
      console.error("Failed to render fallback message:", renderError);
    }
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the fallback response.");
  } finally {
    if (activeStreamController === streamController) activeStreamController = null;
    isGenerating = false;
    setInputState({ disabled: false, locked: isSessionLocked });
    if (!isSessionLocked) document.getElementById("chat-input")?.focus();
    updateProfileUI(getCurrentUser());
  }
}

function handleBackendMemoryUpdates(meta) {
  if (!meta) return;
  let graph = getMemoryGraphContext();

  if (meta.memory_summary) {
    graph = mergeMemoryGraphs(graph, memoryFromBackendSummary(meta.memory_summary));
  }

  if (meta.memory_graph_snapshot && meta.memory_graph_full_snapshot) {
    graph = memoryGraphFromBackend(meta.memory_graph_snapshot);
  } else if (meta.memory_graph_delta) {
    graph = mergeMemoryGraphs(graph, memoryGraphFromBackend(meta.memory_graph_delta));
  }

  if (meta.memory_summary || meta.memory_graph_snapshot || meta.memory_graph_delta) {
    const canonicalGraph = saveMemoryGraphContext(graph);
    setMemoryGraphContext(canonicalGraph);
    setMemoryContext(canonicalGraph);
    renderMemoryInspector();
  }
}

// ═══════════════════════════════════════════════════════════════
// Chat rendering
// ═══════════════════════════════════════════════════════════════

function renderPersistedChat() {
  const state = getState();
  if (!state.chatMemory.length) { setChatStarted(false); return; }

  setChatStarted(true);
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;
  chatHistory.innerHTML = "";

  for (const message of state.chatMemory) {
    if (message.type === "voice_call" && message.voiceCall) {
      insertCallCardUI({
        startTime: message.voiceCall.startTime,
        durationStr: message.voiceCall.durationStr,
        userTranscript: message.voiceCall.userTranscript,
        aiTranscript: message.voiceCall.aiTranscript,
        summary: message.voiceCall.summary || null,
      });
      continue;
    }
    if (message.text && message.text.startsWith("[Voice Call]")) {
      const durationMatch = message.text.match(/\[Voice Call\]\s*(.+)/);
      insertCallCardUI({
        startTime: message.createdAt || new Date().toISOString(),
        durationStr: durationMatch ? durationMatch[1].trim() : "",
        userTranscript: "",
        aiTranscript: "",
        summary: message.voiceCall?.summary || null,
      });
      continue;
    }
    appendMessageToUI(message.text, message.role === "User" ? "user" : "bot", {
      smoothScroll: false, typewriter: false, backendMeta: message,
    });
  }

  scrollChatToBottom("auto", true);
}

function insertCallCardUI({ startTime, durationStr, userTranscript, aiTranscript, summary: existingSummary }) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  const callTime = new Date(startTime);
  const validTime = Number.isFinite(callTime.getTime()) ? callTime : new Date();
  const timeStr = validTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = validTime.toLocaleDateString([], { month: "short", day: "numeric" });
  const safeDuration = escapeHtml(String(durationStr || "").slice(0, 80));
  const safeDate = escapeHtml(dateStr);
  const safeTime = escapeHtml(timeStr);
  const cardId = "call-card-" + Date.now() + Math.random().toString(36).slice(2, 6);
  const summaryId = cardId + "-summary";
  const summaryState = resolveVoiceCallSummaryState({
    existingSummary,
    userTranscript,
    aiTranscript,
  });

  const card = document.createElement("div");
  card.className = "call-card-container w-full flex flex-col items-center my-4 opacity-70";
  card.innerHTML = `
    <div class="flex items-center justify-center w-full">
      <div class="h-px bg-gray-300 dark:bg-gray-700 flex-grow max-w-[100px]"></div>
      <span class="text-xs text-gray-500 dark:text-gray-400 px-3 tracking-wide flex items-center gap-1.5">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
        Call ended · ${safeDuration}
      </span>
      <div class="h-px bg-gray-300 dark:bg-gray-700 flex-grow max-w-[100px]"></div>
    </div>
    <div class="call-summary-row flex items-start gap-1 mt-1.5 cursor-pointer select-none max-w-sm w-full justify-center">
      <p id="${summaryId}" class="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed text-center">${summaryState.shouldSummarize ? '<span class="italic">Summarizing…</span>' : escapeHtml(summaryState.display)}</p>
      <svg class="w-2.5 h-2.5 text-gray-400 dark:text-gray-500 transition-transform duration-200 call-chevron mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div id="${cardId}" class="call-card-details hidden mt-1 text-[10px] text-gray-400 dark:text-gray-500">
      ${safeDate}, ${safeTime} · ${safeDuration}
    </div>
  `;

  chatHistory.appendChild(card);

  const summaryRow = card.querySelector(".call-summary-row");
  const details = card.querySelector(`#${cardId}`);
  const chevron = card.querySelector(".call-chevron");

  summaryRow?.addEventListener("click", () => {
    if (!details || !chevron) return;
    const isOpen = !details.classList.contains("hidden");
    details.classList.toggle("hidden");
    chevron.style.transform = isOpen ? "" : "rotate(180deg)";
  });

  if (summaryState.shouldSummarize) {
    summarizeCallTranscript(userTranscript, aiTranscript).then(summary => {
      const summaryEl = document.getElementById(summaryId);
      if (summaryEl) summaryEl.textContent = summary;
      _persistCallSummary(startTime, summary);
    }).catch(() => {
      const summaryEl = document.getElementById(summaryId);
      if (summaryEl) summaryEl.textContent = "Voice call";
      _persistCallSummary(startTime, "Voice call");
    });
  }
}

function _persistCallSummary(startTime, summary) {
  const state = getState();
  const callMsg = state.chatMemory.findLast?.(m =>
    (m.type === "voice_call" && m.voiceCall?.startTime === startTime) ||
    (m.text?.startsWith("[Voice Call]") && m.voiceCall?.startTime === startTime)
  );
  if (callMsg) {
    if (!callMsg.voiceCall) callMsg.voiceCall = {};
    callMsg.voiceCall.summary = summary;
    patchState({ chatMemory: state.chatMemory });
    // patchState calls saveState internally — force immediate write as well
    saveState({ defer: false });
    console.log("[Voice] Summary persisted:", summary);

    // Sync updated message to cloud so summary isn't lost on next cloud merge
    scheduleCloudMessageSync(callMsg);
  } else {
    console.warn("[Voice] Could not find call message to persist summary. chatMemory length:", state.chatMemory.length);
  }
}

async function summarizeCallTranscript(userTranscript, aiTranscript) {
  try {
    const token = await getIdToken().catch(() => null);
    const headers = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      const appCheckToken = await getAppCheckToken();
      if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;
    }
    const res = await fetch(`${API_BASE_URL}/voice/summarize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ user_transcript: userTranscript || "", ai_transcript: aiTranscript || "" }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return data.summary || "Voice call";
  } catch {
    return "Voice call";
  }
}

async function appendMessageToUI(text, sender, { smoothScroll = true, typewriter = false, backendMeta = null } = {}) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  const msgDiv = document.createElement("div");

  if (sender === "user") {
    msgDiv.className = "flex justify-end w-full animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    msgDiv.innerHTML = `
      <div class="bg-gemini-surface dark:bg-gemini-darkSurface text-gemini-text dark:text-gemini-darkText px-5 py-3 rounded-[24px] max-w-[80%] text-[15px] leading-relaxed" dir="auto">
        ${escapeHtml(text)}
      </div>
    `;
    chatHistory.appendChild(msgDiv);
    if (smoothScroll) scrollChatToBottom("auto", true);
    return;
  }

  const safetyLevel = backendMeta?.safety?.level || backendMeta?.safety?.user_visible_category || "";
  const isCrisis = isCrisisReply(text, safetyLevel);
  const parsed = processStructuredResponse(text, backendMeta?.generationTimeMs || null);

  msgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";

  const contentContainer = document.createElement("div");
  contentContainer.className = `flex flex-col text-[15px] ${isCrisis ? "text-rose-700 dark:text-rose-400 font-medium" : "text-gemini-text dark:text-gemini-darkText"} leading-relaxed max-w-3xl w-full pr-2 sm:pr-0`;

  if (parsed.timelineHtml) {
    const timelineDiv = document.createElement("div");
    timelineDiv.innerHTML = sanitizeRichHtml(parsed.timelineHtml);
    contentContainer.appendChild(timelineDiv);
  }

  const contentBox = document.createElement("div");
  contentBox.className = "content-box";
  contentBox.setAttribute("dir", "auto");

  if (!typewriter) {
    if (!parsed.finalHtml && text.trim()) {
      // Safety net: parser couldn't extract visible content — show raw text
      let raw = text.trim()
        .replace(/^\s*\*{0,2}\s*Thought\s*:?\s*\*{0,2}\s*/i, "")
        .replace(/^\s*Self\s*:\s*/i, "");
      // Strip numbered step lines (1. INTAKE: ..., etc.)
      raw = raw.replace(/(?:^|\n)\s*[1-6][.)]\s*[A-Z][A-Z\s]*:[^\n]*/gi, "").trim();
      // Try to extract content after last delimiter
      const delimMatch = raw.match(/\*{2}\s*(?:Balanced\s*Reframe|Response)\s*:?\s*\*{2}\s*([\s\S]*)/i)
        || raw.match(/(?:Balanced\s*Reframe|Response)\s*:\s*([\s\S]*)/i);
      if (delimMatch && delimMatch[1].trim()) raw = delimMatch[1].trim();
      contentBox.innerHTML = sanitizeRichHtml(raw
        ? `<div class="text-[15px] leading-relaxed" dir="auto">${formatMarkdown(raw)}</div>`
        : `<div class="text-[15px] leading-relaxed text-gray-400 italic">Response could not be parsed. Please try again.</div>`);
    } else {
      contentBox.innerHTML = sanitizeRichHtml(parsed.finalHtml);
    }
  }
  contentContainer.appendChild(contentBox);
  if (!isCrisis) contentContainer.appendChild(buildMessageActions(text));

  if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMeta) {
    const metaEl = buildBackendMeta(backendMeta);
    if (metaEl) contentContainer.appendChild(metaEl);
  }

  msgDiv.appendChild(contentContainer);
  chatHistory.appendChild(msgDiv);
  bindAccordion(msgDiv);
  refreshIcons();

  if (typewriter) {
    await typewriteHTML(contentBox, parsed.finalHtml, chatHistory);
    contentContainer.querySelector(".action-buttons")?.classList.remove("opacity-0");
  }

  if (smoothScroll) scrollChatToBottom("auto");
}

function buildMessageActions(text) {
  const actionDiv = document.createElement("div");
  actionDiv.className = "flex items-center gap-1 mt-3 text-gray-500 dark:text-[#c4c7c5] action-buttons transition-opacity duration-300 opacity-100";

  // Extract only the user-visible portion (strip chain-of-thought)
  const visibleText = extractVisibleText(text);

  actionDiv.innerHTML = `
    <button class="action-play p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Read aloud">
      <i data-lucide="volume-2" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-copy p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Copy text">
      <i data-lucide="copy" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-like p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Good response">
      <i data-lucide="thumbs-up" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-dislike p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Bad response">
      <i data-lucide="thumbs-down" class="w-[15px] h-[15px]"></i>
    </button>
    <button class="action-retry p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors" title="Regenerate">
      <i data-lucide="rotate-cw" class="w-[15px] h-[15px]"></i>
    </button>
  `;

  const playBtn = actionDiv.querySelector(".action-play");
  playBtn?.addEventListener("click", () => speakText(stripMarkdown(visibleText), playBtn, { showToast }));

  actionDiv.querySelector(".action-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(stripMarkdown(visibleText));
      showToast("Copied to clipboard.");
    } catch {
      fallbackCopy(stripMarkdown(visibleText));
      showToast("Copied to clipboard.");
    }
  });

  const likeBtn = actionDiv.querySelector(".action-like");
  const dislikeBtn = actionDiv.querySelector(".action-dislike");
  likeBtn?.addEventListener("click", () => {
    likeBtn.classList.toggle("text-blue-600");
    likeBtn.classList.toggle("dark:text-blue-400");
    dislikeBtn?.classList.remove("text-red-600", "dark:text-red-400");
  });
  dislikeBtn?.addEventListener("click", () => {
    dislikeBtn.classList.toggle("text-red-600");
    dislikeBtn.classList.toggle("dark:text-red-400");
    likeBtn?.classList.remove("text-blue-600", "dark:text-blue-400");
  });

  actionDiv.querySelector(".action-retry")?.addEventListener("click", () => regenerateLastUserMessage(text).catch(console.error));

  return actionDiv;
}

async function regenerateLastUserMessage(targetAssistantText = "") {
  if (isGenerating || isSessionLocked) return;

  const state = getState();
  const messages = Array.isArray(state.chatMemory) ? state.chatMemory : [];
  if (messages.length < 2) { showToast("Nothing to regenerate."); return; }

  const cleanTarget = String(targetAssistantText || "").trim();
  let assistantIndex = -1;

  if (cleanTarget) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "MindPal" && String(messages[i]?.text || "").trim() === cleanTarget) {
        assistantIndex = i;
        break;
      }
    }
  }
  if (assistantIndex < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "MindPal") { assistantIndex = i; break; }
    }
  }
  if (assistantIndex < 0) { showToast("No assistant response to regenerate."); return; }

  let userIndex = assistantIndex - 1;
  while (userIndex >= 0 && messages[userIndex]?.role !== "User") userIndex--;
  if (userIndex < 0) { showToast("No matching user message found."); return; }

  const userMessage = String(messages[userIndex]?.text || "").trim();
  if (!userMessage) { showToast("No matching user message found."); return; }

  let streamController = null;
  isGenerating = true;
  setInputState({ disabled: true, locked: false });
  setChatStarted(true);

  const statusId = `status-regenerate-${Date.now()}`;
  let streamResponseStr = "";
  let streamMsgDiv = null;
  let firstChunkReceived = false;

  try {
    const preservedMessages = messages.slice(0, assistantIndex);
    replaceChatMemory(preservedMessages);
    renderPersistedChat();
    void replaceCloudChatSnapshotSafe(preservedMessages);
    const token = await getIdToken();
    const mode = getCurrentMode();
    const model = getCurrentModel();
    const chatHistory = document.getElementById("chat-history");
    streamMsgDiv = document.createElement("div");
    streamMsgDiv.className = "flex flex-col gap-1 w-full self-start animate-fade-in pl-4 sm:pl-10 pr-2 sm:pr-4";
    if (chatHistory) chatHistory.appendChild(streamMsgDiv);

    appendStatusIndicator(statusId, streamMsgDiv);

    const contentContainer = document.createElement("div");
    contentContainer.className = "flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
    const contentBox = document.createElement("div");
    contentBox.className = "content-box";
    contentContainer.appendChild(contentBox);
    streamMsgDiv.appendChild(contentContainer);
    scrollChatToBottom("auto", true);

    let backendMetaFinal = null;
    let lastRenderTime = 0;
    let renderTimeout = null;
    const streamStartTime = performance.now();
    let earlyRegeneratedMessage = null;

    if (activeStreamController) activeStreamController.abort();
    streamController = new AbortController();
    activeStreamController = streamController;

    await sendChatMessageStream({
      message: userMessage,
      history: messages.slice(0, userIndex),
      locale: resolveLocale(getAppSettings),
      mode,
      model,
      token,
      signal: streamController.signal,
      profileContext: {
        ...(getCurrentCloudProfileContext() || {}),
        settingsMetadata: buildChatSettingsMetadata(),
      },
      onChunk: (chunkText) => {
        streamResponseStr += chunkText;

        // Finalize the "Thinking..." indicator when the response delimiter appears
        if (!firstChunkReceived) {
          const hasDelimiter = /\*{2}\s*(?:Response|Balanced\s*Reframe)\s*:?\s*\*{2}/i.test(streamResponseStr)
            || /(?:\n|^)\s*(?:Response|Balanced\s*Reframe)\s*:\s*/i.test(streamResponseStr);
          if (hasDelimiter) {
            firstChunkReceived = true;
            finalizeStatusIndicator(statusId, performance.now() - streamStartTime);
          }
        }

        const now = performance.now();
        if (now - lastRenderTime > 150) {
          lastRenderTime = now;
          if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
          renderStreamPreview(contentBox, streamResponseStr);
          scrollChatToBottom("auto");
        } else if (!renderTimeout) {
          renderTimeout = requestAnimationFrame(() => {
            renderTimeout = null;
            lastRenderTime = performance.now();
            renderStreamPreview(contentBox, streamResponseStr);
            scrollChatToBottom("auto");
          });
        }
      },
      onStatus: (status) => {
        if (status === "text_finished") {
          if (renderTimeout) { cancelAnimationFrame(renderTimeout); renderTimeout = null; }
          const elapsedMs = performance.now() - streamStartTime;
          const replyText = renderFinalResponse(contentBox, streamResponseStr, elapsedMs);
          if (!firstChunkReceived) finalizeStatusIndicator(statusId, elapsedMs);

          scrollChatToBottom("auto");
          notifyResponseComplete();
          earlyRegeneratedMessage = addMessage("MindPal", replyText, {
            requestId: null, providerUsed: null, safety: null,
            ragUsed: [], memoryUpdated: false, regenerated: true, generationTimeMs: elapsedMs,
          });

          notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the regenerated response.");

          if (!isCrisisReply(replyText, "")) {
            contentContainer.appendChild(buildMessageActions(replyText));
            refreshIcons();
          }
        }
      },
      onMetadata: (meta) => {
        backendMetaFinal = meta;
        if (meta?.runtime_trace) emitSafeModeRuntimeTrace(meta.runtime_trace);
        if (meta.pro_usage) updateUsageFromMeta(meta.pro_usage);
        if (meta.usage) syncUsageFromBackend(meta.usage);
      },
    });

    const publicReply = extractVisibleText(streamResponseStr, { final: true });
    const reply = truncateRepetition(publicReply) || publicReply;
    if (!reply) throw new Error("Backend returned empty public reply.");
    recordMessage(model);

    if (isSafetyLock(backendMetaFinal)) isSessionLocked = true;

    let regeneratedRecord = earlyRegeneratedMessage;
    if (regeneratedRecord) {
      regeneratedRecord.text = reply;
      regeneratedRecord.requestId = backendMetaFinal?.request_id || null;
      regeneratedRecord.providerUsed = backendMetaFinal?.provider_used || null;
      regeneratedRecord.safety = backendMetaFinal?.safety || null;
      regeneratedRecord.ragUsed = backendMetaFinal?.rag_used || [];
      regeneratedRecord.memoryUpdated = Boolean(backendMetaFinal?.memory_updated);
    } else {
      regeneratedRecord = addMessage("MindPal", reply, {
        requestId: backendMetaFinal?.request_id || null,
        providerUsed: backendMetaFinal?.provider_used || null,
        safety: backendMetaFinal?.safety || null,
        ragUsed: backendMetaFinal?.rag_used || [],
        memoryUpdated: Boolean(backendMetaFinal?.memory_updated),
        regenerated: true,
      });
    }

    scheduleCloudMessageSync(regeneratedRecord);
    handleBackendMemoryUpdates(backendMetaFinal);

    const safetyLevel = backendMetaFinal?.safety?.level || backendMetaFinal?.safety?.user_visible_category || "";
    if (isCrisisReply(reply, safetyLevel)) {
      contentContainer.className = "flex flex-col text-[15px] text-rose-700 dark:text-rose-400 font-medium leading-relaxed max-w-3xl w-full pr-2 sm:pr-0";
      contentContainer.querySelector(".action-buttons")?.remove();
    } else if (!contentContainer.querySelector(".action-buttons")) {
      contentContainer.appendChild(buildMessageActions(reply));
    }

    notifyResponseComplete();
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the response.");

    if (window.MINDPAL_CONFIG?.SHOW_RESPONSE_DEBUG && backendMetaFinal) {
      const metaEl = buildBackendMeta(backendMetaFinal);
      if (metaEl) contentContainer.appendChild(metaEl);
    }

    bindAccordion(streamMsgDiv);
    refreshIcons();
  } catch (error) {
    if (error?.name === "AbortError") {
      if (streamMsgDiv) streamMsgDiv.remove();
      return;
    }
    console.error("regenerateLastUserMessage error:", error);
    if (!streamResponseStr.trim() && streamMsgDiv) streamMsgDiv.remove();
    if (!firstChunkReceived) removeStatusIndicator(statusId);

    const fallback = buildClientFallbackReply(error);
    const fallbackRecord = addMessage("MindPal", fallback, {
      providerUsed: "client_fallback",
      errorCode: error?.code || "frontend_regenerate_error",
      regenerated: true,
    });
    scheduleCloudMessageSync(fallbackRecord);

    try {
      await appendMessageToUI(fallback, "bot", { smoothScroll: true, typewriter: true });
    } catch (renderError) {
      console.error("Failed to render regenerate fallback:", renderError);
    }
    notifyFromSetting("responseComplete", "MindPal response ready", "MindPal finished the fallback response.");
  } finally {
    if (activeStreamController === streamController) activeStreamController = null;
    isGenerating = false;
    setInputState({ disabled: false, locked: isSessionLocked });
    if (!isSessionLocked) document.getElementById("chat-input")?.focus();
    updateProfileUI(getCurrentUser());
  }
}

// ═══════════════════════════════════════════════════════════════
// Debug metadata
// ═══════════════════════════════════════════════════════════════

function buildBackendMeta(meta) {
  const provider = meta.provider_used || meta.providerUsed;
  const requestId = meta.request_id || meta.requestId;
  const ragUsed = meta.rag_used || meta.ragUsed || [];

  if (!provider && !requestId && !ragUsed.length) return null;

  const wrapper = document.createElement("details");
  wrapper.className = "mt-3 text-[12px] text-gray-400 dark:text-gray-500";

  const ragText = Array.isArray(ragUsed) && ragUsed.length
    ? ragUsed.slice(0, 3).map((item) => escapeHtml(item.technique || item.grounding_id || "grounding")).join(", ")
    : "none";

  wrapper.innerHTML = `
    <summary class="cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-300">Response details</summary>
    <div class="mt-2 space-y-1">
      ${provider ? `<div>Provider: ${escapeHtml(provider)}</div>` : ""}
      ${requestId ? `<div>Request: ${escapeHtml(requestId)}</div>` : ""}
      <div>Grounding: ${ragText}</div>
    </div>
  `;

  return wrapper;
}

// ═══════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════

window.addEventListener("beforeunload", () => {
  cleanupAuth();
});
