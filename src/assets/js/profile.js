// Profile modal wiring and cloud connect handlers (uses window.initAuth / window.syncToCloud if available)
(function(){
    function $(id){ return document.getElementById(id); }

    const profileBtn = $('profile-btn');
    const profileModal = $('profile-modal');
    const closeProfileBtn = $('close-profile-btn');
    const btnCloudConnect = $('btn-cloud-connect');
    const btnCloudDisconnect = $('btn-cloud-disconnect');
    const userNameInput = $('user-name-input');

    function updateProfileUI() {
        if (typeof window.updateProfileUI === 'function') return window.updateProfileUI();
        // Minimal local update: toggle logged-in/out based on appState
        const loggedOut = $('auth-logged-out');
        const loggedIn = $('auth-logged-in');
        if (!window.appState || !loggedOut || !loggedIn) return;
        if (window.appState.cloudSyncEnabled) {
            loggedOut.classList.add('hidden'); loggedIn.classList.remove('hidden');
        } else {
            loggedOut.classList.remove('hidden'); loggedIn.classList.add('hidden');
        }
    }

    if (profileBtn) {
        profileBtn.addEventListener('click', () => {
            updateProfileUI();
            if (profileModal) profileModal.classList.remove('opacity-0','pointer-events-none');
            const content = $('profile-content'); if (content) content.classList.remove('scale-95');
        });
    }

    if (closeProfileBtn) closeProfileBtn.addEventListener('click', () => {
        if (profileModal) profileModal.classList.add('opacity-0','pointer-events-none');
        const content = $('profile-content'); if (content) content.classList.add('scale-95');
    });

    if (btnCloudConnect) btnCloudConnect.addEventListener('click', async function(){
        if (typeof window.setButtonBusy === 'function') window.setButtonBusy(this, true, 'Connecting...');
        const authed = window.initAuth ? await window.initAuth() : false;
        if (!authed || !window.currentUser) {
            if (typeof window.setButtonBusy === 'function') window.setButtonBusy(this, false);
            if (window.showToast) window.showToast('Could not connect to cloud services.');
            return;
        }
        if (window.syncToCloud) await window.syncToCloud();
        if (window.appState) { window.appState.cloudSyncEnabled = true; if (window.saveState) window.saveState(); }
        updateProfileUI();
        if (typeof window.setButtonBusy === 'function') window.setButtonBusy(this, false);
        if (window.showToast) window.showToast('Cloud sync enabled.');
    });

    if (btnCloudDisconnect) btnCloudDisconnect.addEventListener('click', function(){
        if (window.appState) { window.appState.cloudSyncEnabled = false; if (window.saveState) window.saveState(); }
        updateProfileUI();
        if (window.showToast) window.showToast('Cloud sync disabled.');
    });

    if (userNameInput) userNameInput.addEventListener('change', (e) => {
        const val = e.target.value.trim();
        if (!window.appState) window.appState = {};
        window.appState.userName = val ? val : 'Friend';
        if (window.saveState) window.saveState();
        updateProfileUI();
        if (window.showToast) window.showToast('Profile updated.');
    });

    // Close modal on outside click
    window.addEventListener('click', (e) => {
        if (e.target === profileModal && closeProfileBtn) closeProfileBtn.click();
    });

    // Expose updateProfileUI
    window.updateProfileUI = updateProfileUI;
})();
