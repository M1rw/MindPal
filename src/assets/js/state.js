// State management for MindPal
window.appState = {
    sessionId: 'mp_' + Math.random().toString(36).substr(2, 9),
    chatMemory: [],
    streak: 0,
    lastVisitDate: null,
    visitHistory: [],
    crisisMode: true
};

window.isGenerating = false;

window.saveState = function() {
    localStorage.setItem('mindpal_gemini_state', JSON.stringify(window.appState));
};

window.calculateStreak = function() {
    const today = new Date().toDateString();
    if (!window.appState.visitHistory) window.appState.visitHistory = [];

    if (window.appState.lastVisitDate !== today) {
        if (window.appState.lastVisitDate) {
            const diffTime = Math.abs(new Date() - new Date(window.appState.lastVisitDate));
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            window.appState.streak = (diffDays === 1) ? window.appState.streak + 1 : 1;
        } else {
            window.appState.streak = 1;
        }
        window.appState.lastVisitDate = today;
        if (!window.appState.visitHistory.includes(today)) window.appState.visitHistory.push(today);
        window.saveState();
    } else if (!window.appState.visitHistory.includes(today)) {
        window.appState.visitHistory.push(today);
        window.saveState();
    }

    const streakEl = document.getElementById('streak-counter');
    if (streakEl) streakEl.textContent = window.appState.streak;
};

window.renderWeeklyTracker = function() {
    const countEl = document.getElementById('modal-streak-count');
    if(countEl) countEl.textContent = window.appState.streak;

    const tracker = document.getElementById('weekly-tracker');
    if(!tracker) return;

    tracker.innerHTML = '';
    const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const today = new Date();

    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = d.toDateString();
        const dayLetter = days[d.getDay()];

        const isVisited = window.appState.visitHistory.includes(dateStr);
        const isToday = i === 0;

        let circleClasses = "w-8 h-8 rounded-full flex items-center justify-center text-sm transition-colors ";
        let iconHtml = '';

        if (isVisited) {
            circleClasses += "bg-blue-500 text-white shadow-md border border-blue-600";
            iconHtml = `<i data-lucide="check" class="w-4 h-4"></i>`;
        } else if (isToday) {
            circleClasses += "bg-transparent border-[1.5px] border-dashed border-gray-300 dark:border-[#444746] text-transparent";
        } else {
            circleClasses += "bg-gemini-surface dark:bg-gemini-darkSurface border border-gemini-border dark:border-[#444746] text-transparent";
        }

        const dayHtml = `
            <div class="flex flex-col items-center gap-2">
                <span class="text-[11px] ${isToday ? 'text-gray-900 dark:text-white font-bold' : 'text-gray-400 dark:text-gray-500 font-medium'}">${isToday ? 'Today' : dayLetter}</span>
                <div class="${circleClasses}">${iconHtml}</div>
            </div>
        `;
        tracker.insertAdjacentHTML('beforeend', dayHtml);
    }
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
};

window.renderPersistedChat = function() {
    const welcomeScreen = document.getElementById('welcome-screen');
    const interactionArea = document.getElementById('interaction-area');
    const chatHistory = document.getElementById('chat-history');

    if (welcomeScreen) welcomeScreen.classList.add('hidden');
    if (chatHistory) {
        chatHistory.classList.remove('hidden');
        chatHistory.classList.add('flex');
    }
    if (interactionArea) {
        interactionArea.classList.remove('flex-1', 'justify-center');
        interactionArea.classList.add('flex-none', 'justify-end', 'pt-0');
    }

    if (chatHistory) chatHistory.innerHTML = '';
    window.appState.chatMemory.forEach(msg => {
        if (window.appendMessageToUI) window.appendMessageToUI(msg.text, msg.role === 'User' ? 'user' : 'bot', false, false);
    });
    if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
};

window.loadState = function() {
    const saved = localStorage.getItem('mindpal_gemini_state');
    if (saved) {
        try {
            window.appState = { ...window.appState, ...JSON.parse(saved) };
            if (!window.appState.visitHistory) window.appState.visitHistory = [];
            if (window.appState.crisisMode === undefined) window.appState.crisisMode = true;
        } catch (e) { console.error("Error parsing memory"); }
    }
    window.calculateStreak();
    if (window.appState.chatMemory.length > 0 && window.renderPersistedChat) window.renderPersistedChat();

    const crisisToggle = document.getElementById('crisis-toggle');
    if (crisisToggle) crisisToggle.checked = window.appState.crisisMode;
};
