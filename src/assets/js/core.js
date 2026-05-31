// Initialize Lucide Icons
lucide.createIcons();

const assetBase = location.protocol === 'file:' ? './' : '/assets/';

// Theme Setup
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeIcon = document.getElementById('theme-icon');

// Check for saved theme preference or use system preference
if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
    themeIcon.setAttribute('data-lucide', 'sun');
} else {
    document.documentElement.classList.remove('dark');
    themeIcon.setAttribute('data-lucide', 'moon');
}
lucide.createIcons();

// Handle Theme Toggle
themeToggleBtn.addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    if (document.documentElement.classList.contains('dark')) {
        localStorage.setItem('theme', 'dark');
        themeIcon.setAttribute('data-lucide', 'sun');
    } else {
        localStorage.setItem('theme', 'light');
        themeIcon.setAttribute('data-lucide', 'moon');
    }
    lucide.createIcons(); // re-render the specific icon
});

// Elements
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const modeBtn = document.getElementById('mode-selector-btn');
const modeDropdown = document.getElementById('mode-dropdown');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsContent = document.getElementById('settings-content');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const regionPickerBtn = document.getElementById('region-picker-btn');
const regionPickerValue = document.getElementById('region-picker-value');
const regionPickerMenu = document.getElementById('region-picker-menu');
const regionOptionButtons = document.querySelectorAll('.region-option');
const regionHint = document.getElementById('region-hint');
const clearMemoryBtn = document.getElementById('clear-memory-btn');
const exportChatBtn = document.getElementById('export-chat-btn');
const newSessionBtn = document.getElementById('new-session-btn');
const sessionIdLabel = document.getElementById('session-id-label');
const savedTurnsLabel = document.getElementById('saved-turns-label');
const lastExportedLabel = document.getElementById('last-exported-label');
const toastRoot = document.getElementById('toast-root');
const confirmOverlay = document.getElementById('confirm-overlay');
const confirmContent = document.getElementById('confirm-content');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const confirmOkBtn = document.getElementById('confirm-ok-btn');
const crisisToggle = document.getElementById('crisis-toggle');
const currentModeText = document.getElementById('current-mode-text');
const currentModeIconSlot = document.getElementById('current-mode-icon-slot');
const modeOptions = document.querySelectorAll('.mode-option');
const featureToggleBtn = document.getElementById('feature-toggle-btn');

const welcomeScreen = document.getElementById('welcome-screen');
const chatHistory = document.getElementById('chat-history');
const chatContainer = document.getElementById('chat-container');
let isFocusRepliesOn = false;
let activeMode = 'Companion';
const conversationMemory = [];
let settingsCloseTimer = null;
let __iconRefreshQueued = false;

function refreshIcons() {
    if (__iconRefreshQueued) return;
    __iconRefreshQueued = true;
    requestAnimationFrame(() => {
        __iconRefreshQueued = false;
        lucide.createIcons();
    });
}

function detectClientRegion() {
    try {
        const langs = Array.isArray(navigator.languages) && navigator.languages.length
            ? navigator.languages
            : [navigator.language || ''];
        const langBlob = langs.join(' ').toLowerCase();
        const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '').toLowerCase();

        const isUSorCanada =
            /-us\b|\bus\b|-ca\b|\bcanada\b/.test(langBlob) ||
            /(america\/|canada\/|toronto|vancouver|montreal)/.test(tz);
        if (isUSorCanada) return 'us_ca';

        const isUKorIreland =
            /-gb\b|\buk\b|-ie\b|\bireland\b|\benglish\b/.test(langBlob) ||
            /(europe\/london|europe\/dublin)/.test(tz);
        if (isUKorIreland) return 'uk_ie';

        const isAustralia =
            /-au\b|\baustralia\b/.test(langBlob) ||
            /australia\//.test(tz);
        if (isAustralia) return 'au';

        const isIndia =
            /-in\b|\bindia\b|\bhindi\b/.test(langBlob) ||
            /asia\/kolkata/.test(tz);
        if (isIndia) return 'in';
    } catch (error) {
        console.warn('Region auto-detect failed; falling back to global.', error);
    }

    return 'global';
}

const REGION_OVERRIDE_KEY = 'mindpal.regionOverride';
const SESSION_ID_KEY = 'mindpal.sessionId';
const LAST_EXPORT_AT_KEY = 'mindpal.lastExportAt';
const AUTO_DETECTED_REGION = detectClientRegion();

function generateSessionId() {
    const generated = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    return generated;
}

function getOrCreateSessionId() {
    const existing = (localStorage.getItem(SESSION_ID_KEY) || '').trim();
    if (existing) return existing;

    const generated = generateSessionId();
    localStorage.setItem(SESSION_ID_KEY, generated);
    return generated;
}

function getStoredRegionOverride() {
    const raw = (localStorage.getItem(REGION_OVERRIDE_KEY) || 'auto').trim().toLowerCase();
    const allowed = new Set(['auto', 'us_ca', 'uk_ie', 'au', 'in', 'global']);
    return allowed.has(raw) ? raw : 'auto';
}

function getEffectiveRegion() {
    const override = getStoredRegionOverride();
    return override === 'auto' ? AUTO_DETECTED_REGION : override;
}

let CLIENT_REGION = getEffectiveRegion();
let SESSION_ID = getOrCreateSessionId();

function getRegionLabel(regionCode) {
    const labels = {
        us_ca: 'U.S./Canada',
        uk_ie: 'UK/Ireland',
        au: 'Australia',
        in: 'India',
        global: 'Global',
    };
    return labels[regionCode] || 'Global';
}

function formatDateTimeForUi(timestampMs) {
    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) return 'Never';
    return date.toLocaleString();
}

function refreshLastExportLabel() {
    if (!lastExportedLabel) return;
    const raw = localStorage.getItem(LAST_EXPORT_AT_KEY);
    if (!raw) {
        lastExportedLabel.textContent = 'Never';
        return;
    }
    const asNumber = Number(raw);
    lastExportedLabel.textContent = formatDateTimeForUi(asNumber);
}

function refreshSessionLabels(savedTurns = null) {
    if (sessionIdLabel) {
        sessionIdLabel.textContent = SESSION_ID.slice(0, 8);
    }
    if (savedTurnsLabel) {
        if (typeof savedTurns === 'number') {
            savedTurnsLabel.textContent = String(savedTurns);
        } else {
            savedTurnsLabel.textContent = String(conversationMemory.length);
        }
    }
    refreshLastExportLabel();
}

async function refreshSessionStats() {
    if (location.protocol === 'file:') {
        refreshSessionLabels(conversationMemory.length);
        return;
    }

    try {
        const response = await fetch(`/api/session/export?session_id=${encodeURIComponent(SESSION_ID)}`);
        if (!response.ok) {
            throw new Error(`status ${response.status}`);
        }
        const data = await response.json();
        const turns = Array.isArray(data.history) ? data.history.length : 0;
        refreshSessionLabels(turns);
    } catch {
        refreshSessionLabels(conversationMemory.length);
    }
}

function refreshRegionSettingsUI() {
    if (!regionHint) return;
    const override = getStoredRegionOverride();
    regionHint.textContent = `Auto detected: ${getRegionLabel(AUTO_DETECTED_REGION)}.`;
    if (regionPickerValue) {
        regionPickerValue.textContent = override === 'auto' ? 'Auto-detect' : getRegionLabel(override);
    }

    regionOptionButtons.forEach((btn) => {
        const isActive = btn.getAttribute('data-region') === override;
        btn.classList.toggle('bg-blue-50', isActive);
        btn.classList.toggle('dark:bg-blue-900/30', isActive);
        btn.classList.toggle('text-blue-700', isActive);
        btn.classList.toggle('dark:text-blue-300', isActive);
    });

    refreshSessionLabels();
}

function closeSettingsPanel() {
    if (!settingsPanel) return;
    settingsPanel.classList.add('opacity-0', 'pointer-events-none');
    settingsContent?.classList.add('scale-95');
    settingsContent?.classList.remove('scale-100');
    if (regionPickerMenu) {
        regionPickerMenu.classList.add('hidden');
    }

    if (settingsCloseTimer) {
        clearTimeout(settingsCloseTimer);
    }
    settingsCloseTimer = window.setTimeout(() => {
        settingsPanel.classList.add('hidden');
    }, 220);
}

function toggleSettingsPanel() {
    if (!settingsPanel) return;
    if (settingsPanel.classList.contains('hidden')) {
        settingsPanel.classList.remove('hidden');
        requestAnimationFrame(() => {
            settingsPanel.classList.remove('opacity-0', 'pointer-events-none');
            settingsContent?.classList.remove('scale-95');
            settingsContent?.classList.add('scale-100');
        });
        return;
    }

    closeSettingsPanel();
}

function showToast(message, kind = 'info') {
    if (!toastRoot) return;

    const palette = {
        info: 'border-gray-200 dark:border-gray-700 bg-white/96 dark:bg-gray-900/96 text-gray-700 dark:text-gray-200',
        success: 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/96 dark:bg-emerald-900/25 text-emerald-700 dark:text-emerald-300',
        error: 'border-rose-200 dark:border-rose-900/60 bg-rose-50/96 dark:bg-rose-900/25 text-rose-700 dark:text-rose-300',
        warning: 'border-amber-200 dark:border-amber-900/60 bg-amber-50/96 dark:bg-amber-900/25 text-amber-700 dark:text-amber-300',
    };

    const icons = {
        info: 'info',
        success: 'check-circle-2',
        error: 'x-circle',
        warning: 'alert-circle',
    };

    const el = document.createElement('div');
    el.className = `toast-message animate-toast flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg backdrop-blur ${palette[kind] || palette.info}`;
    el.innerHTML = `<i data-lucide="${icons[kind] || icons.info}" class="w-4 h-4 shrink-0"></i><span>${message}</span>`;
    toastRoot.appendChild(el);
    refreshIcons();

    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
        el.classList.remove('is-visible');
        setTimeout(() => el.remove(), 200);
    }, 2200);
}

function setButtonBusy(button, busy, busyLabel) {
    if (!button) return;
    if (!button.dataset.idleLabel) {
        const textNode = button.querySelector('.btn-text');
        button.dataset.idleLabel = textNode ? textNode.textContent : (button.textContent || '');
    }
    button.disabled = busy;
    button.classList.toggle('opacity-70', busy);
    button.classList.toggle('cursor-not-allowed', busy);

    const textNode = button.querySelector('.btn-text');
    const iconNode = button.querySelector('.btn-icon');

    if (textNode) {
        textNode.textContent = busy ? busyLabel : button.dataset.idleLabel;
    } else {
        button.textContent = busy ? busyLabel : button.dataset.idleLabel;
    }

    if (iconNode) {
        if (busy) {
            iconNode.setAttribute('data-lucide', 'loader-2');
            iconNode.classList.add('animate-spin');
        } else {
            iconNode.classList.remove('animate-spin');
            const iconName = button.id === 'export-chat-btn' ? 'download' : button.id === 'new-session-btn' ? 'refresh-cw' : 'trash-2';
            iconNode.setAttribute('data-lucide', iconName);
        }
    }

    refreshIcons();
}

function formatTimestampForFilename(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function requestConfirmation({ title, message, confirmLabel = 'Confirm' }) {
    if (!confirmOverlay || !confirmTitle || !confirmMessage || !confirmCancelBtn || !confirmOkBtn) {
        return Promise.resolve(window.confirm(message || 'Are you sure?'));
    }

    confirmTitle.textContent = title || 'Confirm action';
    confirmMessage.textContent = message || 'Are you sure?';
    confirmOkBtn.textContent = confirmLabel;
    confirmOverlay.classList.remove('hidden');
    requestAnimationFrame(() => {
        confirmOverlay.classList.remove('opacity-0');
        confirmContent?.classList.remove('scale-95');
        confirmContent?.classList.add('scale-100');
    });

    return new Promise((resolve) => {
        const cleanup = () => {
            confirmOverlay.classList.add('opacity-0');
            confirmContent?.classList.add('scale-95');
            confirmContent?.classList.remove('scale-100');
            confirmCancelBtn.removeEventListener('click', onCancel);
            confirmOkBtn.removeEventListener('click', onConfirm);
            confirmOverlay.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onEsc);
            window.setTimeout(() => {
                confirmOverlay.classList.add('hidden');
            }, 180);
        };

        const onCancel = (event) => {
            event.stopPropagation();
            cleanup();
            resolve(false);
        };
        const onConfirm = (event) => {
            event.stopPropagation();
            cleanup();
            resolve(true);
        };
        const onBackdrop = (event) => {
            event.stopPropagation();
            if (event.target === confirmOverlay) {
                cleanup();
                resolve(false);
            }
        };
        const onEsc = (event) => {
            if (event.key === 'Escape') {
                cleanup();
                resolve(false);
            }
        };

        confirmCancelBtn.addEventListener('click', onCancel);
        confirmOkBtn.addEventListener('click', onConfirm);
        confirmOverlay.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onEsc);
    });
}

function postJSON(path, payload) {
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).then(async (response) => {
        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || `Request failed with status ${response.status}`);
        }
        return response.json();
    });
}

function syncChatActiveClass() {
    const isChatActive = welcomeScreen.classList.contains('hidden');
    document.body.classList.toggle('chat-active', isChatActive);
}

function scrollChatToBottom(smooth = true) {
    const behavior = smooth ? 'smooth' : 'auto';
    requestAnimationFrame(() => {
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior });
    });
}

const disabledClasses = ['bg-surfaceHover', 'text-gray-400', 'dark:bg-gray-700', 'dark:text-gray-500'];
const enabledClasses = ['bg-gray-800', 'text-white', 'hover:bg-gray-900', 'hover:scale-105', 'dark:bg-gray-200', 'dark:text-gray-900', 'dark:hover:bg-white'];

function pushMemory(role, text) {
    conversationMemory.push({ role, text });
    if (conversationMemory.length > 24) {
        conversationMemory.shift();
    }
}

// Settings / shell wiring
featureToggleBtn.addEventListener('click', () => {
    isFocusRepliesOn = !isFocusRepliesOn;
    featureToggleBtn.classList.toggle('bg-amber-100', isFocusRepliesOn);
    featureToggleBtn.classList.toggle('dark:bg-amber-500/15', isFocusRepliesOn);
    featureToggleBtn.classList.toggle('text-amber-600', isFocusRepliesOn);
    featureToggleBtn.classList.toggle('dark:text-amber-300', isFocusRepliesOn);
    featureToggleBtn.classList.toggle('ring-1', isFocusRepliesOn);
    featureToggleBtn.classList.toggle('ring-amber-300/60', isFocusRepliesOn);
    featureToggleBtn.classList.toggle('dark:ring-amber-400/40', isFocusRepliesOn);
    featureToggleBtn.classList.toggle('shadow-sm', isFocusRepliesOn);
    featureToggleBtn.title = isFocusRepliesOn ? 'Concise Mode: ON' : 'Concise Mode: OFF';
});

inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';

    if (this.value.trim().length > 0) {
        sendBtn.disabled = false;
        sendBtn.classList.remove(...disabledClasses);
        sendBtn.classList.add(...enabledClasses);
    } else {
        sendBtn.disabled = true;
        sendBtn.classList.add(...disabledClasses);
        sendBtn.classList.remove(...enabledClasses);
    }
});

modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modeDropdown.classList.contains('hidden')) {
        modeDropdown.classList.remove('hidden');
        modeDropdown.classList.add('dropdown-enter-active');
    } else {
        closeDropdown();
    }
});

document.addEventListener('click', (e) => {
    if (!modeDropdown.contains(e.target) && !modeBtn.contains(e.target)) {
        closeDropdown();
    }

    if (
        regionPickerMenu &&
        regionPickerBtn &&
        !regionPickerMenu.classList.contains('hidden') &&
        !regionPickerMenu.contains(e.target) &&
        !regionPickerBtn.contains(e.target)
    ) {
        regionPickerMenu.classList.add('hidden');
    }
});

if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        refreshRegionSettingsUI();
        toggleSettingsPanel();
        refreshSessionStats();
    });
}

if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        closeSettingsPanel();
    });
}

if (settingsPanel) {
    settingsPanel.addEventListener('click', (event) => {
        if (event.target === settingsPanel) {
            closeSettingsPanel();
        }
    });
}

if (crisisToggle) {
    crisisToggle.addEventListener('click', () => {
        showToast('Crisis support stays enabled for safety.', 'info');
    });
}

if (regionPickerBtn && regionPickerMenu) {
    regionPickerBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        regionPickerMenu.classList.toggle('hidden');
    });
}

regionOptionButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        const value = (btn.getAttribute('data-region') || 'auto').toLowerCase();
        localStorage.setItem(REGION_OVERRIDE_KEY, value);
        CLIENT_REGION = getEffectiveRegion();
        refreshRegionSettingsUI();
        if (regionPickerMenu) {
            regionPickerMenu.classList.add('hidden');
        }
    });
});

if (clearMemoryBtn) {
    clearMemoryBtn.addEventListener('click', async () => {
        const approved = await requestConfirmation({
            title: 'Clear session memory?',
            message: 'This will remove the saved conversation for this session and cannot be undone.',
            confirmLabel: 'Clear memory',
        });
        if (!approved) {
            return;
        }

        setButtonBusy(clearMemoryBtn, true, 'Clearing...');
        try {
            await postJSON('/api/session/clear', { session_id: SESSION_ID });
            conversationMemory.length = 0;
            chatHistory.innerHTML = '';
            refreshSessionLabels(0);
            showToast('Session memory cleared.', 'success');
        } catch (error) {
            showToast('Could not clear memory right now.', 'error');
            console.error(error);
        } finally {
            setButtonBusy(clearMemoryBtn, false, 'Clearing...');
        }
    });
}

if (exportChatBtn) {
    exportChatBtn.addEventListener('click', async () => {
        setButtonBusy(exportChatBtn, true, 'Exporting...');
        try {
            const response = await fetch(`/api/session/export?session_id=${encodeURIComponent(SESSION_ID)}`);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `Export failed with status ${response.status}`);
            }

            const data = await response.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `mindpal-session-${SESSION_ID.slice(0, 8)}-${formatTimestampForFilename()}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            localStorage.setItem(LAST_EXPORT_AT_KEY, String(Date.now()));
            refreshLastExportLabel();
            showToast('Chat exported.', 'success');
        } catch (error) {
            showToast('Could not export chat right now.', 'error');
            console.error(error);
        } finally {
            setButtonBusy(exportChatBtn, false, 'Exporting...');
        }
    });
}

if (newSessionBtn) {
    newSessionBtn.addEventListener('click', async () => {
        const approved = await requestConfirmation({
            title: 'Start a new session?',
            message: 'This will switch to a new session ID and start with a clean conversation view.',
            confirmLabel: 'Start new session',
        });
        if (!approved) {
            return;
        }

        setButtonBusy(newSessionBtn, true, 'Starting...');
        try {
            const oldSessionId = SESSION_ID;
            try {
                await postJSON('/api/session/clear', { session_id: oldSessionId });
            } catch {
                // non-blocking: session may already be gone or running in file:// mode
            }

            SESSION_ID = generateSessionId();
            localStorage.setItem(SESSION_ID_KEY, SESSION_ID);
            conversationMemory.length = 0;
            chatHistory.innerHTML = '';
            refreshSessionLabels(0);
            showToast('New session started.', 'success');
        } catch (error) {
            showToast('Could not start a new session right now.', 'error');
            console.error(error);
        } finally {
            setButtonBusy(newSessionBtn, false, 'Starting...');
        }
    });
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (regionPickerMenu && !regionPickerMenu.classList.contains('hidden')) {
            regionPickerMenu.classList.add('hidden');
        } else if (settingsPanel && !settingsPanel.classList.contains('hidden')) {
            closeSettingsPanel();
        }
    }
});

refreshRegionSettingsUI();
refreshLastExportLabel();
