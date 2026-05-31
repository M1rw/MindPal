// Modals, settings, export & clear
(function() {
    const settingsModal = document.getElementById('settings-modal');
    const settingsBtn = document.getElementById('settings-btn');
    const closeSettingsBtn = document.getElementById('close-settings-btn');
    const streakBtn = document.getElementById('streak-btn');
    const streakModal = document.getElementById('streak-modal');
    const closeStreakBtn = document.getElementById('close-streak-btn');
    const exportBtn = document.getElementById('export-chat-btn');
    const clearBtn = document.getElementById('clear-chat-btn');
    const crisisToggle = document.getElementById('crisis-toggle');

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            const sid = document.getElementById('label-session-id');
            const smsg = document.getElementById('label-saved-turns');
            if(sid) sid.textContent = window.appState.sessionId;
            if(smsg) smsg.textContent = window.appState.chatMemory.length;

            if (settingsModal) settingsModal.classList.remove('opacity-0', 'pointer-events-none');
            const content = document.getElementById('settings-content');
            if (content) content.classList.remove('scale-95');
        });
    }

    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', () => {
            if (settingsModal) settingsModal.classList.add('opacity-0', 'pointer-events-none');
            const content = document.getElementById('settings-content');
            if (content) content.classList.add('scale-95');
        });
    }

    if (streakBtn) {
        streakBtn.addEventListener('click', () => {
            if (window.renderWeeklyTracker) window.renderWeeklyTracker();
            if (streakModal) streakModal.classList.remove('opacity-0', 'pointer-events-none');
            const content = document.getElementById('streak-content');
            if (content) content.classList.remove('scale-95');
        });
    }

    if (closeStreakBtn) {
        closeStreakBtn.addEventListener('click', () => {
            if (streakModal) streakModal.classList.add('opacity-0', 'pointer-events-none');
            const content = document.getElementById('streak-content');
            if (content) content.classList.add('scale-95');
        });
    }

    window.addEventListener('click', (e) => {
        if(e.target === streakModal && closeStreakBtn) closeStreakBtn.click();
        if(e.target === settingsModal && closeSettingsBtn) closeSettingsBtn.click();
    });

    if (crisisToggle) {
        crisisToggle.addEventListener('change', (e) => {
            window.appState.crisisMode = e.target.checked;
            if (window.saveState) window.saveState();
            if (window.showToast) window.showToast(window.appState.crisisMode ? "Crisis interception enabled" : "Crisis interception disabled");
        });
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', function() {
            if (window.appState.chatMemory.length === 0) return window.showToast && window.showToast("No conversation to export.");
            if (window.setButtonBusy) window.setButtonBusy(this, true, "Exporting...");
            setTimeout(() => {
                let fileContent = `MindPal Session Export\nDate: ${new Date().toLocaleString()}\n\n`;
                window.appState.chatMemory.forEach(msg => fileContent += `[${msg.role}]\n${msg.text}\n\n`);
                const blob = new Blob([fileContent], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `MindPal_Log_${Date.now()}.txt`;
                a.click();
                URL.revokeObjectURL(url);
                if (window.showToast) window.showToast("Log exported.");
                if (window.setButtonBusy) window.setButtonBusy(this, false);
            }, 500);
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function() {
            if(confirm("Wipe all persistent chat memory? This cannot be undone.")) {
                window.appState.chatMemory = [];
                if (window.saveState) window.saveState();
                location.reload();
            }
        });
    }
})();
