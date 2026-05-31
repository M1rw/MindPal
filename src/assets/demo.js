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
    } catch (e) {
        console.warn('Region auto-detect failed; falling back to global.', e);
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
        // file:// demo fallback
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
    lucide.createIcons();

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

    lucide.createIcons();
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
        const onBackdrop = (e) => {
            e.stopPropagation();
            if (e.target === confirmOverlay) {
                cleanup();
                resolve(false);
            }
        };
        const onEsc = (e) => {
            if (e.key === 'Escape') {
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

function syncChatActiveClass() {
    // Single source of truth: fade/shadow visuals are enabled only when welcome is hidden.
    const isChatActive = welcomeScreen.classList.contains('hidden');
    document.body.classList.toggle('chat-active', isChatActive);
}

function scrollChatToBottom(smooth = true) {
    const behavior = smooth ? 'smooth' : 'auto';
    requestAnimationFrame(() => {
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior });
    });
}

const modeIconNameByMode = {
    Companion: 'message-circle-heart',
    'Cognitive Tools': 'brain-circuit',
    Resources: 'library',
};

function setCurrentModeIcon(modeName) {
    currentModeIconSlot.className = 'w-4 h-4 flex items-center justify-center';
    if (modeName === 'Cognitive Tools') {
        currentModeIconSlot.classList.add('text-purple-500', 'dark:text-purple-400');
    } else if (modeName === 'Resources') {
        currentModeIconSlot.classList.add('text-emerald-500', 'dark:text-emerald-400');
    } else {
        currentModeIconSlot.classList.add('text-blue-500', 'dark:text-blue-400');
    }
    const iconName = modeIconNameByMode[modeName] || modeIconNameByMode.Companion;
    currentModeIconSlot.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4"></i>`;
    lucide.createIcons();
}

function getModeAccentClasses(modeName) {
    if (modeName === 'Cognitive Tools') {
        return {
            avatar: 'bg-purple-50 dark:bg-purple-900/30 text-purple-500 dark:text-purple-400',
            icon: 'brain-circuit',
        };
    }
    if (modeName === 'Resources') {
        return {
            avatar: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-500 dark:text-emerald-400',
            icon: 'library',
        };
    }
    return {
        avatar: 'bg-blue-50 dark:bg-blue-900/30 text-blue-500 dark:text-blue-400',
        icon: 'message-circle-heart',
    };
}

function getBotAvatarHtml(modeName) {
    const accent = getModeAccentClasses(modeName);
    return `<div class="w-8 h-8 rounded-full ${accent.avatar} flex items-center justify-center flex-shrink-0 overflow-hidden">
        <img src="${assetBase}img/logo.jpg" alt="MindPal" class="h-full w-full object-cover" />
    </div>`;
}

setCurrentModeIcon('Companion');

function isNearBottom() {
    const threshold = 160;
    return (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) < threshold;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function prepareBotBodyForFinalContent(element) {
    applyBotTypography(element);
    element.classList.add('whitespace-pre-wrap');
}

function applyBotTypography(element, variant = 'reply') {
    if (variant === 'thinking') {
        element.className = 'text-sm leading-6 tracking-tight text-gray-500 dark:text-gray-400 max-w-3xl';
        return;
    }

    element.className = 'text-[15px] leading-7 tracking-[-0.01em] text-gray-700 dark:text-gray-200 max-w-3xl';
}

function renderInlineMarkdown(value) {
    let safe = escapeHtml(value || '');
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/__(.+?)__/g, '<strong>$1</strong>');
    safe = safe.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<em>$1</em>');
    safe = safe.replace(/(?<!_)_(?!\s)(.+?)(?<!\s)_(?!_)/g, '<em>$1</em>');
    return safe;
}

function formatMarkdownToHtml(md) {
    const source = String(md || '').trim();
    if (!source) return '';

    const blocks = source.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
    const rendered = blocks.map((block) => {
        if (/^###\s+/.test(block)) {
            return `<h3 class="text-lg font-semibold text-gray-900 dark:text-gray-50 mb-1">${renderInlineMarkdown(block.replace(/^###\s+/, ''))}</h3>`;
        }

        if (/^>\s*/.test(block)) {
            const quoteText = block
                .replace(/^>\s*/gm, '')
                .replace(/\n+/g, ' ')
                .trim();
            return `<div class="rounded-2xl border border-gray-200/80 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-800/50 px-4 py-3"><p class="text-sm leading-6 text-gray-600 dark:text-gray-300">${renderInlineMarkdown(quoteText)}</p></div>`;
        }

        if (/^-\s+/.test(block)) {
            const items = block
                .split('\n')
                .map(line => line.replace(/^-\s+/, '').trim())
                .filter(Boolean)
                .map(line => `<li class="flex gap-2 leading-6"><span class="mt-2 h-1.5 w-1.5 rounded-full bg-blue-400 dark:bg-blue-300 flex-shrink-0"></span><span>${renderInlineMarkdown(line)}</span></li>`)
                .join('');

            return `<ul class="space-y-2 my-1">${items}</ul>`;
        }

        if (/^\*\*(.+?)\*\*:\s*(.+)$/s.test(block)) {
            const match = block.match(/^\*\*(.+?)\*\*:\s*(.+)$/s);
            if (match) {
                return `<div class="rounded-2xl border border-gray-200/70 dark:border-gray-700/70 bg-white/70 dark:bg-gray-800/40 px-4 py-3"><p class="text-sm leading-6 text-gray-700 dark:text-gray-200"><strong>${renderInlineMarkdown(match[1])}:</strong> ${renderInlineMarkdown(match[2].replace(/\n+/g, ' '))}</p></div>`;
            }
        }

        if (/^\*\*(.+?)\*\*$/.test(block)) {
            const match = block.match(/^\*\*(.+?)\*\*$/);
            if (match) {
                return `<h4 class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">${renderInlineMarkdown(match[1])}</h4>`;
            }
        }

        return `<p class="text-base leading-7 text-gray-700 dark:text-gray-200">${renderInlineMarkdown(block.replace(/\n+/g, ' '))}</p>`;
    }).join('');

    return `<div class="space-y-4">${rendered}</div>`;
}

function formatResourceMarkdownToHtml(md) {
    const lines = String(md || '').split(/\r?\n/).map(line => line.trim());
    if (!lines.some(Boolean)) return '';

    const tips = [];
    let title = '';
    let description = '';
    let hotline = '';
    let index = 0;

    while (index < lines.length && !lines[index]) {
        index += 1;
    }

    if (lines[index]?.startsWith('### ')) {
        title = lines[index].replace(/^###\s+/, '');
        index += 1;
    }

    while (index < lines.length && !lines[index]) {
        index += 1;
    }

    const quoteLines = [];
    while (index < lines.length && lines[index].startsWith('>')) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
    }
    if (quoteLines.length) {
        description = quoteLines.join(' ');
    }

    while (index < lines.length && !lines[index]) {
        index += 1;
    }

    if (lines[index]?.startsWith('**Hotline:**')) {
        hotline = lines[index].replace(/^\*\*Hotline:\*\*\s*/, '');
        index += 1;
    }

    while (index < lines.length && !lines[index]) {
        index += 1;
    }

    if (lines[index]?.startsWith('**Coping Tips:**')) {
        index += 1;
        while (index < lines.length) {
            const line = lines[index];
            index += 1;
            if (!line) continue;
            if (line.startsWith('- ')) {
                tips.push(line.replace(/^-\s+/, ''));
            } else {
                tips.push(line);
            }
        }
    }

    const titleText = title ? renderInlineMarkdown(title.replace(/^[^\w]+\s*/, '')) : '';
    const descriptionText = description ? renderInlineMarkdown(description) : '';
    const hotlineText = hotline ? renderInlineMarkdown(hotline) : '';
    const tipsHtml = tips.length
        ? `<ul class="space-y-1.5">${tips.map(tip => `<li class="flex gap-2 text-sm leading-6 text-gray-700 dark:text-gray-200"><span class="mt-2 h-1.5 w-1.5 rounded-full bg-blue-400 dark:bg-blue-300 flex-shrink-0"></span><span>${renderInlineMarkdown(tip)}</span></li>`).join('')}</ul>`
        : '';

    return `<div class="rounded-2xl border border-gray-200/70 dark:border-gray-700/70 bg-white/85 dark:bg-gray-800/45 px-4 py-4 shadow-sm"><div class="flex items-start gap-2"><span class="mt-0.5 text-lg shrink-0">🧠</span><div class="min-w-0 flex-1">${titleText ? `<h3 class="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-50 leading-6">${titleText}</h3>` : ''}${descriptionText ? `<p class="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">${descriptionText}</p>` : ''}</div></div><div class="mt-3 rounded-xl border border-gray-200/60 dark:border-gray-700/60 bg-gray-50/70 dark:bg-gray-800/30 px-3 py-2.5"><div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500 mb-1">Hotline</div><p class="text-sm leading-6 text-gray-700 dark:text-gray-200">${hotlineText}</p></div>${tipsHtml ? `<div class="mt-3"><div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500 mb-2">Coping tips</div>${tipsHtml}</div>` : ''}</div>`;
}

async function postJSON(path, payload) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Request failed with status ${response.status}`);
    }

    return response.json();
}

// Send Button State Management
const disabledClasses = ['bg-surfaceHover', 'text-gray-400', 'dark:bg-gray-700', 'dark:text-gray-500'];
const enabledClasses = ['bg-gray-800', 'text-white', 'hover:bg-gray-900', 'hover:scale-105', 'dark:bg-gray-200', 'dark:text-gray-900', 'dark:hover:bg-white'];

// Feature toggle: short/focused bot replies.
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

// Auto-resize textarea
inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    
    // Toggle Send button state
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

// Handle Mode Dropdown Toggle
modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modeDropdown.classList.contains('hidden')) {
        modeDropdown.classList.remove('hidden');
        modeDropdown.classList.add('dropdown-enter-active');
    } else {
        closeDropdown();
    }
});

// Close dropdown when clicking outside
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
    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
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
    regionPickerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
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

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (regionPickerMenu && !regionPickerMenu.classList.contains('hidden')) {
            regionPickerMenu.classList.add('hidden');
        } else if (settingsPanel && !settingsPanel.classList.contains('hidden')) {
            closeSettingsPanel();
        }
    }
});

function closeDropdown() {
    if (!modeDropdown.classList.contains('hidden')) {
        modeDropdown.classList.add('hidden');
    }
}

// Handle Mode Selection
modeOptions.forEach(option => {
    option.addEventListener('click', (e) => {
        const modeName = option.getAttribute('data-mode');
        
        // Update button text and icon
        currentModeText.textContent = modeName;
        setCurrentModeIcon(modeName);
        
        closeDropdown();
        inputEl.focus();
    });
});

// Handle Suggestion Chips
document.querySelectorAll('.suggestion-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const text = e.target.closest('button').textContent.trim();
        inputEl.value = text;
        // Trigger input event to resize and enable button
        inputEl.dispatchEvent(new Event('input'));
        inputEl.focus();
        // If hero is visible, switch to chat layout so the input anchors to bottom
        if (!welcomeScreen.classList.contains('hidden')) {
            showChatHistory();
        }
    });
});

// Simulate Sending Message
sendBtn.addEventListener('click', handleSend);
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) handleSend();
    }
});

function handleSend() {
    const text = inputEl.value.trim();
    if (!text) return;

    // Hide welcome screen, show chat history
    if (!welcomeScreen.classList.contains('hidden')) {
        showChatHistory();
    }

    // Append User Message
    appendMessage(text, 'user');
    pushMemory('user', text);

    activeMode = currentModeText.textContent.trim() || 'Companion';
    
    // Clear input
    inputEl.value = '';
    inputEl.style.height = 'auto';
    inputEl.dispatchEvent(new Event('input'));

    requestBotResponse(text, activeMode);
}

function pushMemory(role, text) {
    conversationMemory.push({ role, text });
    if (conversationMemory.length > 24) {
        conversationMemory.shift();
    }
}

// Adjust hero layout on small screens to avoid subtitle/input overlap
function adjustHeroForSmallScreens() {
    try {
        const mq = window.matchMedia('(max-width: 480px)');
        if (!mq.matches) {
            return;
        }
        const sub = document.querySelector('.welcome-subtitle');
        const input = document.querySelector('.input-hero');
        if (!sub || !input) return;
        const sRect = sub.getBoundingClientRect();
        const iRect = input.getBoundingClientRect();
        // If subtitle bottom would overlap input top, anchor input to bottom
            if (sRect.bottom > iRect.top) {
                // apply inline styles to force bottom anchoring when overlap detected
                input.style.top = 'auto';
                input.style.bottom = '12px';
                input.style.transform = 'translateX(-50%)';
                input.style.transition = 'none';
            } else {
                // clear inline overrides so the default centered layout can apply
                input.style.top = '';
                input.style.bottom = '';
                input.style.transform = '';
                input.style.transition = '';
            }
    } catch (e) {
        // silently ignore in older browsers
        console.error(e);
    }
}

// Run adjust on load and on resize/orientation changes (debounced)
let __resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(__resizeTimer);
    __resizeTimer = setTimeout(adjustHeroForSmallScreens, 140);
});
window.addEventListener('orientationchange', () => setTimeout(adjustHeroForSmallScreens, 180));
document.addEventListener('DOMContentLoaded', () => setTimeout(adjustHeroForSmallScreens, 300));
// initial call in case script loaded after DOM; give extra time for fonts/layout
setTimeout(adjustHeroForSmallScreens, 600);


function showChatHistory() {
    // Hide welcome hero
    welcomeScreen.classList.add('hidden');

    // Reveal chat history container with a downward slide and soft shadow
    chatHistory.classList.remove('hidden');
    chatHistory.classList.add('flex');
    chatHistory.classList.add('chat-enter');

    // Remove hero centering so input moves to bottom
    document.body.classList.remove('hero-centered');
    syncChatActiveClass();
    // also clear any inline anchoring we applied for hero view
    const el = document.querySelector('.input-hero');
    if (el) { el.style.top = ''; el.style.bottom = ''; el.style.transform = ''; el.style.transition = ''; }

    // Activate the enter animation on next frame
    requestAnimationFrame(() => {
        chatHistory.classList.add('chat-enter-active');
        chatHistory.classList.remove('chat-enter');
        setTimeout(() => {
            chatHistory.classList.remove('chat-enter-active');
        }, 380);
    });
}

async function requestBotResponse(text, mode) {
    const pendingBubble = appendThinkingMessage(mode);

    try {
        const result = await postJSON('/api/ask', {
            text,
            mode,
            history: conversationMemory,
            region: CLIENT_REGION,
            sessionId: SESSION_ID,
        });
        const bubbleBody = pendingBubble.querySelector('[data-role="bot-body"]');
        if (!bubbleBody) return;

        if (result.mode === 'crisis' || result.mode === 'resources') {
            const resource = result.resource || {};
            const markdown = resource.markdown || 'No resources available.';
            await typewriterIntoElement(bubbleBody, markdown);
            bubbleBody.classList.remove('typing-caret');
            prepareBotBodyForFinalContent(bubbleBody);
            bubbleBody.classList.remove('whitespace-pre-wrap');
            bubbleBody.innerHTML = formatResourceMarkdownToHtml(markdown);
            if (result.mode === 'crisis') {
                const regionLabel = getRegionLabel(result.region || CLIENT_REGION);
                bubbleBody.insertAdjacentHTML(
                    'afterbegin',
                    `<div class="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-400 dark:text-gray-500">Regional support: ${escapeHtml(regionLabel)}</div>`
                );
            }
            const links = buildLinksHtml(resource.links || []);
            if (links) {
                bubbleBody.insertAdjacentHTML('beforeend', links);
            }
            pushMemory('assistant', markdown);
            return;
        }

        let answer = String(result.result || 'No response available.');
        if (isFocusRepliesOn) {
            answer = answer.slice(0, 320);
        }

        await typewriterIntoElement(bubbleBody, answer);
        bubbleBody.classList.remove('typing-caret');
        prepareBotBodyForFinalContent(bubbleBody);
        bubbleBody.innerHTML = formatMarkdownToHtml(answer);
        pushMemory('assistant', answer);
    } catch (error) {
        const bubbleBody = pendingBubble.querySelector('[data-role="bot-body"]');
        if (bubbleBody) {
            bubbleBody.classList.remove('typing-caret');
            bubbleBody.innerHTML = "<p>I couldn't complete that request right now. Please try again in a moment.</p>";
        }
        console.error(error);
    }
}

function buildLinksHtml(links = []) {
    if (!Array.isArray(links) || !links.length) return '';
    return `<div class="flex flex-wrap gap-2 mt-4 pt-2">${links
        .map(item => `<a class="inline-flex items-center px-3 py-1.5 rounded-full border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-200 bg-white/70 dark:bg-gray-800/60 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`)
        .join('')}</div>`;
}

function appendThinkingMessage(mode = activeMode) {
    const accent = getModeAccentClasses(mode);
    const msgDiv = document.createElement('div');
    msgDiv.className = 'flex items-center gap-4 w-full bot-fade-in';
    msgDiv.innerHTML = `
        <div class="w-8 h-8 rounded-full ${accent.avatar} flex items-center justify-center flex-shrink-0 overflow-hidden">
            <img src="${assetBase}img/logo.jpg" alt="MindPal" class="h-full w-full object-cover" />
        </div>
        <div class="text-gray-800 dark:text-gray-200 max-w-3xl min-h-8 flex items-center">
            <div class="flex items-center gap-2" data-role="bot-body">
                <span>Thinking...</span>
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
                <span class="thinking-dot"></span>
            </div>
        </div>
    `;
    const body = msgDiv.querySelector('[data-role="bot-body"]');
    if (body) applyBotTypography(body, 'thinking');
    chatHistory.appendChild(msgDiv);
    lucide.createIcons();
    scrollChatToBottom(true);
    return msgDiv;
}

async function typewriterIntoElement(element, fullText) {
    element.classList.add('typing-caret');
    element.classList.add('whitespace-pre-wrap');
    element.textContent = '';

    const text = String(fullText || '');
    const step = Math.max(2, Math.floor(text.length / 220));

    for (let i = 0; i < text.length; i += step) {
        element.textContent = text.slice(0, i + step);
        if (isNearBottom()) {
            scrollChatToBottom(false);
        }
        await new Promise(resolve => setTimeout(resolve, 4));
    }

    element.textContent = text;
}

function appendMessage(text, sender, links = [], isHtml = false, mode = activeMode) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `flex items-start gap-4 w-full ${sender === 'bot' ? 'bot-fade-in' : 'animate-fade-in'} ${sender === 'user' ? 'justify-end' : ''}`;
    
    if (sender === 'bot') {
        const linksHtml = buildLinksHtml(links);
        const accent = getModeAccentClasses(mode);
        msgDiv.innerHTML = `
            <div class="w-8 h-8 rounded-full ${accent.avatar} flex items-center justify-center flex-shrink-0 overflow-hidden">
                <img src="${assetBase}img/logo.jpg" alt="MindPal" class="h-full w-full object-cover" />
            </div>
            <div class="max-w-3xl space-y-4 text-gray-800 dark:text-gray-200">
                <div class="bot-reply-content whitespace-pre-wrap text-[15px] leading-7 tracking-[-0.01em] text-gray-700 dark:text-gray-200">${isHtml ? text : escapeHtml(text)}</div>
                ${linksHtml}
            </div>
        `;
    } else {
        msgDiv.innerHTML = `
            <div class="bg-gray-100 dark:bg-gray-800 rounded-3xl px-5 py-3 text-gray-800 dark:text-gray-200 max-w-2xl leading-relaxed">
                ${escapeHtml(text)}
            </div>
        `;
    }
    
    chatHistory.appendChild(msgDiv);
    lucide.createIcons();
    
    scrollChatToBottom(true);
}

// Quick health check in browser console (skip when opened directly from disk)
if (location.protocol !== 'file:') {
    fetch('/api/health').then(r => r.json()).then(data => console.log('MindPal API:', data)).catch(console.error);
}

// Initialize visual mode state on load
syncChatActiveClass();
refreshRegionSettingsUI();
refreshLastExportLabel();