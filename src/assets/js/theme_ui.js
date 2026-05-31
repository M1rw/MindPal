// Theme and UI utilities
if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

window.updateThemeUI = function(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    const themeIcon = document.getElementById('theme-icon');
    const modalThemeToggle = document.getElementById('modal-theme-toggle');
    if (themeIcon) themeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
    if (modalThemeToggle) modalThemeToggle.checked = isDark;
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
};

window.setInputState = function(disabled) {
    window.isGenerating = disabled;
    const inputEl = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const voiceBtn = document.getElementById('voice-btn');
    const modeBtn = document.getElementById('mode-selector-btn');

    if(inputEl) inputEl.disabled = disabled;
    if(modeBtn) modeBtn.disabled = disabled;

    if (disabled) {
        if(inputEl) inputEl.placeholder = "MindPal is responding...";
        if(sendBtn) sendBtn.disabled = true;
        if(voiceBtn) voiceBtn.classList.add('opacity-30', 'pointer-events-none');
        if(modeBtn) modeBtn.classList.add('opacity-50', 'pointer-events-none');
    } else {
        if(inputEl) inputEl.placeholder = "Ask MindPal";
        if(sendBtn) sendBtn.disabled = (inputEl.value.trim().length === 0);
        if(voiceBtn) voiceBtn.classList.remove('opacity-30', 'pointer-events-none');
        if(modeBtn) modeBtn.classList.remove('opacity-50', 'pointer-events-none');
    }
};

window.setButtonBusy = function(btn, isBusy, loadingText = "Processing...") {
    if (!btn) return;
    const textEl = btn.querySelector('.btn-text');
    const iconEl = btn.querySelector('.btn-icon');
    if (isBusy) {
        btn.disabled = true;
        if(textEl) btn.dataset.originalText = textEl.textContent;
        if(iconEl) btn.dataset.originalIcon = iconEl.getAttribute('data-lucide');
        if(textEl) textEl.textContent = loadingText;

        if (iconEl) {
            const newIcon = document.createElement('i');
            newIcon.className = iconEl.className + ' animate-spin';
            newIcon.setAttribute('data-lucide', 'loader-2');
            iconEl.replaceWith(newIcon);
        }
    } else {
        btn.disabled = false;
        if (textEl && btn.dataset.originalText) textEl.textContent = btn.dataset.originalText;

        if (iconEl && btn.dataset.originalIcon) {
            const newIcon = document.createElement('i');
            newIcon.className = iconEl.className.replace(' animate-spin', '');
            newIcon.setAttribute('data-lucide', btn.dataset.originalIcon);

            const currentIcon = btn.querySelector('[data-lucide]');
            if (currentIcon) currentIcon.replaceWith(newIcon);
        }
    }
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
};

window.showToast = function(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `flex items-center gap-2 px-4 py-3 rounded-2xl shadow-lg animate-toast pointer-events-auto bg-gray-900 dark:bg-white text-white dark:text-gray-900`;
    toast.innerHTML = `<i data-lucide="info" class="w-4 h-4 opacity-80"></i><span class="text-sm font-medium">${message}</span>`;
    container.appendChild(toast);
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(1rem)';
        toast.style.transition = 'all 0.3s ease-in';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

// Theme initialization
(function() {
    const isDarkMode = localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
    window.updateThemeUI(isDarkMode);

    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const modalThemeToggle = document.getElementById('modal-theme-toggle');
    if (themeToggleBtn) themeToggleBtn.addEventListener('click', function() {
        const willBeDark = !document.documentElement.classList.contains('dark');
        localStorage.setItem('theme', willBeDark ? 'dark' : 'light');
        window.updateThemeUI(willBeDark);
    });
    if (modalThemeToggle) modalThemeToggle.addEventListener('change', function() {
        const willBeDark = !document.documentElement.classList.contains('dark');
        localStorage.setItem('theme', willBeDark ? 'dark' : 'light');
        window.updateThemeUI(willBeDark);
    });
})();
