lucide.createIcons();

// --- APP STATE & CACHE ---
let appState = {
    sessionId: 'mp_' + Math.random().toString(36).substr(2, 9),
    chatMemory: [],
    streak: 0,
    lastVisitDate: null,
    visitHistory: [],
    crisisMode: true,
    cloudSyncEnabled: false,
    userName: "Friend"
};
let isGenerating = false;

// --- FIREBASE SETUP ---
let auth, db, appId;
let currentUser = null;

try {
    const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
    if (firebaseConfig) {
        const app = firebase.initializeApp(firebaseConfig);
        auth = firebase.auth(app);
        db = firebase.firestore(app);
        appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        
        auth.onAuthStateChanged((user) => {
            currentUser = user;
        });
    }
} catch(e) { console.warn("Firebase not initialized in this environment."); }

async function initAuth() {
    if (!auth) return false;
    try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await auth.signInWithCustomToken(__initial_auth_token);
        } else {
            await auth.signInAnonymously();
        }
        return true;
    } catch (e) {
        console.error("Auth init failed:", e);
        return false;
    }
}

async function syncToCloud() {
    if (!currentUser || !appState.cloudSyncEnabled || !db) return;
    const userRef = db.doc(`artifacts/${appId}/users/${currentUser.uid}/mindpal_data/state`);
    try { await userRef.set(appState); } catch(e) { console.error("Cloud save failed", e); }
}

function saveState() {
    localStorage.setItem('mindpal_gemini_state', JSON.stringify(appState));
    if (appState.cloudSyncEnabled) syncToCloud();
}

async function loadState() {
    // 1. Load Local
    const saved = localStorage.getItem('mindpal_gemini_state');
    if (saved) {
        try {
            appState = { ...appState, ...JSON.parse(saved) };
            if (!appState.visitHistory) appState.visitHistory = [];
            if (appState.crisisMode === undefined) appState.crisisMode = true;
            if (!appState.userName) appState.userName = "Friend";
        } catch (e) { console.error("Error parsing memory"); }
    }

    // 2. Setup Base UI
    calculateStreak();
    updateProfileUI();
    setGreeting();
    const crisisToggle = document.getElementById('crisis-toggle');
    if (crisisToggle) crisisToggle.checked = appState.crisisMode;

    // 3. Check Cloud Auto-Login
    if (appState.cloudSyncEnabled) {
        const authed = await initAuth();
        if (authed && currentUser) {
                    const userRef = db.doc(`artifacts/${appId}/users/${currentUser.uid}/mindpal_data/state`);
            try {
                        const docSnap = await userRef.get();
                if (docSnap.exists()) {
                    appState = { ...appState, ...docSnap.data() };
                    localStorage.setItem('mindpal_gemini_state', JSON.stringify(appState));
                    calculateStreak();
                    updateProfileUI();
                    setGreeting();
                }
            } catch (e) { console.error("Could not fetch cloud data on boot"); }
        }
    }

    if (appState.chatMemory.length > 0) renderPersistedChat();
}

// --- AUTH & PROFILE UI LOGIC ---
const profileModal = document.getElementById('profile-modal');
const profileBtn = document.getElementById('profile-btn');
const closeProfileBtn = document.getElementById('close-profile-btn');
const streakBtn = document.getElementById('streak-btn');
const btnCloudConnect = document.getElementById('btn-cloud-connect');
const btnCloudDisconnect = document.getElementById('btn-cloud-disconnect');
const userNameInput = document.getElementById('user-name-input');
const streakModal = document.getElementById('streak-modal');
const closeStreakBtn = document.getElementById('close-streak-btn');

function updateProfileUI() {
    const loggedOutView = document.getElementById('auth-logged-out');
    const loggedInView = document.getElementById('auth-logged-in');
    const profileAvatar = document.getElementById('profile-avatar');
    const envTag = document.getElementById('env-tag');

    if (appState.cloudSyncEnabled) {
        loggedOutView.classList.add('hidden');
        loggedInView.classList.remove('hidden');
        loggedInView.classList.add('flex');
        
        document.getElementById('stat-messages').textContent = appState.chatMemory.filter(m => m.role === 'User').length;
        document.getElementById('stat-days').textContent = appState.visitHistory.length;
        userNameInput.value = appState.userName !== "Friend" ? appState.userName : "";
        
        const initial = (appState.userName && appState.userName !== "Friend") ? appState.userName.charAt(0).toUpperCase() : "U";
        document.getElementById('profile-initial').textContent = initial;
        
        profileAvatar.className = 'w-8 h-8 rounded-full bg-[#9b72cb] flex items-center justify-center text-white border border-transparent';
        profileAvatar.innerHTML = `<span class="text-sm font-bold">${initial}</span>`;
        
        if (envTag) {
            envTag.innerHTML = `<i data-lucide="cloud" class="w-3 h-3 inline-block mr-1 mb-[2px]"></i>Cloud`;
            envTag.className = 'px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-900/30 text-[10px] font-medium text-blue-600 dark:text-blue-400 transition-colors flex items-center';
        }
    } else {
        loggedOutView.classList.remove('hidden');
        loggedInView.classList.add('hidden');
        loggedInView.classList.remove('flex');
        
        profileAvatar.className = 'w-8 h-8 rounded-full bg-gray-200 dark:bg-zinc-700 flex items-center justify-center text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-zinc-600';
        profileAvatar.innerHTML = `<i data-lucide="user" class="w-4 h-4"></i>`;
        
        if (envTag) {
            envTag.textContent = "Local";
            envTag.className = 'px-2 py-0.5 rounded-md bg-gemini-surface dark:bg-gemini-darkSurface text-[10px] font-medium text-gray-500 dark:text-gray-400 transition-colors';
        }
    }
    lucide.createIcons();
    setGreeting();
}

if (profileBtn) {
    profileBtn.addEventListener('click', () => {
        updateProfileUI();
        if (profileModal) profileModal.classList.remove('opacity-0', 'pointer-events-none');
        const content = document.getElementById('profile-content');
        if (content) content.classList.remove('scale-95');
    });
}

if (streakBtn) {
    streakBtn.addEventListener('click', () => {
        renderWeeklyTracker();
        if (streakModal) streakModal.classList.remove('opacity-0', 'pointer-events-none');
        const content = document.getElementById('streak-content');
        if (content) content.classList.remove('scale-95');
    });
}

if (closeProfileBtn) {
    closeProfileBtn.addEventListener('click', () => {
        if (profileModal) profileModal.classList.add('opacity-0', 'pointer-events-none');
        const content = document.getElementById('profile-content');
        if (content) content.classList.add('scale-95');
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
    if(e.target === profileModal && closeProfileBtn) closeProfileBtn.click();
    if(e.target === streakModal && closeStreakBtn) closeStreakBtn.click();
});

if (userNameInput) {
    userNameInput.addEventListener('change', (e) => {
        const val = e.target.value.trim();
        appState.userName = val ? val : "Friend";
        saveState();
        updateProfileUI();
        showToast("Profile updated.");
    });
}

if (btnCloudConnect) {
    btnCloudConnect.addEventListener('click', async () => {
        setButtonBusy(btnCloudConnect, true, "Connecting...");
        const authed = await initAuth();
        if (!authed || !currentUser) {
            setButtonBusy(btnCloudConnect, false);
            return showToast("Could not connect to cloud services.");
        }

        const userRef = db.doc(`artifacts/${appId}/users/${currentUser.uid}/mindpal_data/state`);
        const docSnap = await userRef.get();

        if (docSnap.exists()) {
            appState = { ...appState, ...docSnap.data() };
            appState.cloudSyncEnabled = true;
            showToast("Cloud profile loaded successfully.");
        } else {
            appState.cloudSyncEnabled = true;
            showToast("Cloud sync enabled. Data backed up.");
        }
        
        saveState();
        calculateStreak();
        renderPersistedChat();
        updateProfileUI();
        setButtonBusy(btnCloudConnect, false);
    });
}

if (btnCloudDisconnect) {
    btnCloudDisconnect.addEventListener('click', () => {
        appState.cloudSyncEnabled = false;
        saveState();
        updateProfileUI();
        showToast("Cloud sync disabled. Using local storage.");
    });
}

// --- TIME-AWARE GREETING ---
function setGreeting() {
    const hour = new Date().getHours();
    const name = appState.userName && appState.userName !== "Friend" ? appState.userName : "friend";
    let greeting = `Hello, ${name}.`;
    if (hour >= 5 && hour < 12) greeting = `Good morning, ${name}.`;
    else if (hour >= 12 && hour < 18) greeting = `Good afternoon, ${name}.`;
    else greeting = `Good evening, ${name}.`;
    
    const greetingEl = document.getElementById('greeting-text');
    if (greetingEl) greetingEl.textContent = greeting;
}

function calculateStreak() {
    const today = new Date().toDateString();
    if (!appState.visitHistory) appState.visitHistory = [];
    
    if (appState.lastVisitDate !== today) {
        if (appState.lastVisitDate) {
            const diffTime = Math.abs(new Date() - new Date(appState.lastVisitDate));
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            appState.streak = (diffDays === 1) ? appState.streak + 1 : 1;
        } else {
            appState.streak = 1;
        }
        appState.lastVisitDate = today;
        if (!appState.visitHistory.includes(today)) appState.visitHistory.push(today);
        saveState();
    } else if (!appState.visitHistory.includes(today)) {
        appState.visitHistory.push(today);
        saveState();
    }
    
    const streakEl = document.getElementById('streak-counter');
    if (streakEl) streakEl.textContent = appState.streak;
}

function renderWeeklyTracker() {
    const countEl = document.getElementById('modal-streak-count');
    if(countEl) countEl.textContent = appState.streak;
    
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
        
        const isVisited = appState.visitHistory.includes(dateStr);
        const isToday = i === 0;
        
        let circleClasses = "w-8 h-8 rounded-full flex items-center justify-center text-sm transition-colors ";
        let iconHtml = '';
        
        if (isVisited) {
            circleClasses += "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 shadow-sm";
            iconHtml = `<i data-lucide="check" class="w-4 h-4 stroke-[2.5]"></i>`;
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
    lucide.createIcons();
}

function renderPersistedChat() {
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
    appState.chatMemory.forEach(msg => {
        appendMessageToUI(msg.text, msg.role === 'User' ? 'user' : 'bot', false, false);
    });
    if (chatHistory) chatHistory.scrollTop = chatHistory.scrollHeight;
}

// --- THEME & SETTINGS LOGIC ---
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeIcon = document.getElementById('theme-icon');
const modalThemeToggle = document.getElementById('modal-theme-toggle');

function updateThemeUI(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    if (themeIcon) themeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
    if (modalThemeToggle) modalThemeToggle.checked = isDark;
    lucide.createIcons();
}

function toggleTheme() {
    const willBeDark = !document.documentElement.classList.contains('dark');
    localStorage.setItem('theme', willBeDark ? 'dark' : 'light');
    updateThemeUI(willBeDark);
}

if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);
if (modalThemeToggle) modalThemeToggle.addEventListener('change', toggleTheme);

const crisisToggle = document.getElementById('crisis-toggle');
if (crisisToggle) {
    crisisToggle.addEventListener('change', (e) => {
        appState.crisisMode = e.target.checked;
        saveState();
        showToast(appState.crisisMode ? "Crisis interception enabled" : "Crisis interception disabled");
    });
}

const exportBtn = document.getElementById('export-chat-btn');
const clearBtn = document.getElementById('clear-chat-btn');

if (exportBtn) {
    exportBtn.addEventListener('click', function() {
        if (appState.chatMemory.length === 0) return showToast("No conversation to export.");
        setButtonBusy(this, true, "Exporting...");
        setTimeout(() => {
            let fileContent = `MindPal Session Export\nDate: ${new Date().toLocaleString()}\n\n`;
            appState.chatMemory.forEach(msg => fileContent += `[${msg.role}]\n${msg.text}\n\n`);
            const blob = new Blob([fileContent], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `MindPal_Log_${Date.now()}.txt`;
            a.click();
            URL.revokeObjectURL(url);
            showToast("Log exported.");
            setButtonBusy(this, false);
        }, 500);
    });
}

if (clearBtn) {
    clearBtn.addEventListener('click', function() {
        if(confirm("Wipe all persistent chat memory? This cannot be undone.")) {
            appState.chatMemory = [];
            saveState();
            location.reload(); 
        }
    });
}

// --- UI UTILS ---
function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `flex items-center gap-2 px-4 py-3 rounded-2xl shadow-lg animate-toast pointer-events-auto bg-gray-900 dark:bg-white text-white dark:text-gray-900`;
    toast.innerHTML = `<i data-lucide="info" class="w-4 h-4 opacity-80"></i><span class="text-sm font-medium">${message}</span>`;
    container.appendChild(toast);
    lucide.createIcons();
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(1rem)';
        toast.style.transition = 'all 0.3s ease-in';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function setInputState(disabled) {
    isGenerating = disabled;
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
}

function setButtonBusy(btn, isBusy, loadingText = "Processing...") {
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
    lucide.createIcons();
}

// --- INTERACTION LOGIC ---
const inputEl = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const voiceBtn = document.getElementById('voice-btn');
const modeBtn = document.getElementById('mode-selector-btn');
const modeDropdown = document.getElementById('mode-dropdown');

if (inputEl) {
    inputEl.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        
        if (this.value.trim().length > 0) {
            if (voiceBtn) {
                voiceBtn.classList.add('hidden');
                voiceBtn.classList.remove('flex');
            }
            if (sendBtn) {
                sendBtn.classList.remove('hidden');
                sendBtn.classList.add('flex');
                sendBtn.disabled = isGenerating;
            }
        } else {
            if (voiceBtn) {
                voiceBtn.classList.remove('hidden');
                voiceBtn.classList.add('flex');
            }
            if (sendBtn) {
                sendBtn.classList.add('hidden');
                sendBtn.classList.remove('flex');
                sendBtn.disabled = true;
            }
        }
    });

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { 
            e.preventDefault(); 
            if (sendBtn && !sendBtn.disabled && !isGenerating) handleSend(); 
        }
    });
}

if (modeBtn) {
    modeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (modeDropdown) {
            modeDropdown.classList.toggle('hidden');
            if(!modeDropdown.classList.contains('hidden')) modeDropdown.classList.add('dropdown-enter-active');
        }
    });
}

document.addEventListener('click', (e) => {
    if (modeDropdown && modeBtn && !modeDropdown.contains(e.target) && !modeBtn.contains(e.target)) {
        modeDropdown.classList.add('hidden');
    }
});

document.querySelectorAll('.mode-option').forEach(option => {
    option.addEventListener('click', () => {
        const modeText = document.getElementById('current-mode-text');
        if (modeText) modeText.textContent = option.getAttribute('data-mode');
        
        if (modeDropdown) modeDropdown.classList.add('hidden');
        if (inputEl) inputEl.focus();
    });
});

document.querySelectorAll('.mood-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (inputEl) {
            inputEl.value = `I'm feeling ${e.currentTarget.getAttribute('data-mood').toLowerCase()} right now.`;
            inputEl.dispatchEvent(new Event('input'));
            if (!isGenerating) handleSend();
        }
    });
});

if (sendBtn) {
    sendBtn.addEventListener('click', () => {
        if (!isGenerating) handleSend();
    });
}

// --- GEMINI API & MESSAGING ---
const apiKey = ""; 

async function callGemini(userMessage, systemInstruction, history = []) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
    let contents = history.map(msg => ({ role: msg.role === 'User' ? 'user' : 'model', parts: [{ text: msg.text }] }));
    if (userMessage) contents.push({ role: 'user', parts: [{ text: userMessage }] });

    const payload = { contents, systemInstruction: { parts: [{ text: systemInstruction }] } };
    
    for (let attempt = 0; attempt <= 3; attempt++) {
        try {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const data = await response.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || "Processing error.";
        } catch (error) {
            if (attempt === 3) return "System offline. Please try again.";
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
}

function appendStatusIndicator(id) {
    const chatHistory = document.getElementById('chat-history');
    if (!chatHistory) return;
    const msgDiv = document.createElement('div');
    msgDiv.id = id;
    msgDiv.className = `flex w-full animate-fade-in pl-10`;
    msgDiv.innerHTML = `
        <div class="text-[15px] font-medium shimmer-text">Thought for a few seconds...</div>
    `;
    chatHistory.appendChild(msgDiv);
    lucide.createIcons();
    chatHistory.scrollTo({ top: chatHistory.scrollHeight, behavior: 'smooth' });
}

function formatMarkdown(text) {
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100 font-semibold">$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>');
}

function getCleanTextForCopy(text) {
    if (text.includes('**Thought:**') && text.includes('**Balanced Reframe:**')) {
        const reframeIndex = text.indexOf('**Balanced Reframe:**');
        const actionIndex = text.indexOf('**Next Tiny Action:**');
        
        let reframe = '';
        let action = '';
        
        if (actionIndex !== -1) {
            reframe = text.substring(reframeIndex + '**Balanced Reframe:**'.length, actionIndex).trim();
            action = text.substring(actionIndex + '**Next Tiny Action:**'.length).trim();
        } else {
            reframe = text.substring(reframeIndex + '**Balanced Reframe:**'.length).trim();
        }

        let clean = reframe.replace(/\*\*(.*?)\*\*/g, '$1');
        if (action) {
            clean += `\n\nNext Action: ${action.replace(/\*\*(.*?)\*\*/g, '$1')}`;
        }
        return clean;
    }
    return text.replace(/\*\*(.*?)\*\*/g, '$1'); 
}

function processCBTResponse(text) {
    if (text.includes('**Thought:**') && text.includes('**Balanced Reframe:**')) {
        try {
            const getSection = (startLbl, endLbl) => {
                const start = text.indexOf(startLbl);
                if (start === -1) return '';
                const end = endLbl ? text.indexOf(endLbl, start) : text.length;
                if (end === -1) return text.substring(start + startLbl.length).trim();
                return text.substring(start + startLbl.length, end).trim();
            };

            const thought = getSection('**Thought:**', '**Distortion:**');
            const distortion = getSection('**Distortion:**', '**Evidence For:**');
            const evFor = getSection('**Evidence For:**', '**Evidence Against:**');
            const evAgainst = getSection('**Evidence Against:**', '**Balanced Reframe:**');
            const reframe = getSection('**Balanced Reframe:**', '**Next Tiny Action:**');
            const action = getSection('**Next Tiny Action:**', null);

            if (!reframe) return { timelineHtml: '', finalHtml: formatMarkdown(text) };

            const timelineHtml = `
                <div class="thought-accordion group mb-5">
                    <div class="accordion-header flex items-center gap-2 cursor-pointer text-[15px] text-[#444746] dark:text-[#c4c7c5] hover:text-gray-900 dark:hover:text-white font-medium select-none transition-colors w-fit">
                        <span class="collapsed-text">Thought for a few seconds</span>
                        <span class="expanded-text hidden">Analyzed cognitive patterns</span>
                        <i data-lucide="chevron-right" class="w-4 h-4 transition-transform duration-300 transform chevron-icon"></i>
                    </div>
                    
                    <div class="accordion-content grid grid-rows-[0fr] opacity-0 transition-all duration-300 ease-in-out">
                        <div class="overflow-hidden">
                            <div class="mt-4 ml-[7px] pl-6 border-l border-gray-200 dark:border-[#444746] space-y-5 text-[15px] text-gray-700 dark:text-gray-300 relative pb-4">
                                
                                ${thought ? `
                                <div class="relative">
                                    <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
                                        <i data-lucide="circle-minus" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
                                    </div>
                                    <div class="leading-relaxed"><strong class="text-gray-900 dark:text-white font-semibold">Core Thought:</strong> ${formatMarkdown(thought)}</div>
                                </div>` : ''}

                                ${distortion ? `
                                <div class="relative">
                                    <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
                                        <i data-lucide="circle-minus" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
                                    </div>
                                    <div class="leading-relaxed"><strong class="text-gray-900 dark:text-white font-semibold">Distortion Detected:</strong> ${formatMarkdown(distortion)}</div>
                                </div>` : ''}

                                ${(evFor || evAgainst) ? `
                                <div class="relative">
                                    <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
                                        <i data-lucide="circle-minus" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
                                    </div>
                                    <div class="leading-relaxed space-y-1">
                                        <strong class="text-gray-900 dark:text-white font-semibold block mb-1">Evidence Review:</strong>
                                        ${evFor ? `<div><span class="text-gray-500 dark:text-[#c4c7c5]">For:</span> ${formatMarkdown(evFor)}</div>` : ''}
                                        ${evAgainst ? `<div><span class="text-gray-500 dark:text-[#c4c7c5]">Against:</span> ${formatMarkdown(evAgainst)}</div>` : ''}
                                    </div>
                                </div>` : ''}
                                
                                <div class="relative">
                                    <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
                                        <i data-lucide="check-circle-2" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
                                    </div>
                                    <div class="leading-relaxed font-medium">Done</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            let finalHtml = `<div class="text-[15px] leading-relaxed mb-4">${formatMarkdown(reframe)}</div>`;
            if (action) {
                finalHtml += `<div class="mt-4"><strong class="text-gray-900 dark:text-white font-semibold">Next Action:</strong> ${formatMarkdown(action)}</div>`;
            }
            
            return { timelineHtml, finalHtml };
        } catch (e) {
            return { timelineHtml: '', finalHtml: formatMarkdown(text) };
        }
    }
    return { timelineHtml: '', finalHtml: formatMarkdown(text) };
}

async function typewriteHTML(element, html, scrollContainer) {
    element.innerHTML = '';
    const tokens = html.match(/(<[^>]+>|[^<]+)/g) || [];
    let currentHTML = '';
    
    for (const token of tokens) {
        if (token.startsWith('<')) {
            currentHTML += token;
            element.innerHTML = currentHTML;
        } else {
            for (let i = 0; i < token.length; i++) {
                currentHTML += token.charAt(i);
                element.innerHTML = currentHTML;
                if (i % 3 === 0) scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'auto' });
                await new Promise(r => setTimeout(r, 6)); 
            }
        }
    }
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
}

async function handleSend() {
    if (isGenerating) return;
    const text = inputEl ? inputEl.value.trim() : '';
    if (!text) return;

    setInputState(true);

    const welcomeScreen = document.getElementById('welcome-screen');
    const chatHistory = document.getElementById('chat-history');
    const interactionArea = document.getElementById('interaction-area');

    if (welcomeScreen) welcomeScreen.classList.add('hidden');
    if (chatHistory) {
        chatHistory.classList.remove('hidden');
        chatHistory.classList.add('flex');
    }
    if (interactionArea) {
        interactionArea.classList.remove('flex-1', 'justify-center');
        interactionArea.classList.add('flex-none', 'justify-end', 'pt-0');
    }

    await appendMessageToUI(text, 'user', true, false);
    
    if (inputEl) {
        inputEl.value = '';
        inputEl.style.height = 'auto';
        inputEl.dispatchEvent(new Event('input'));
    }

    if (appState.crisisMode && (text.toLowerCase().includes('suicide') || text.toLowerCase().includes('kill myself') || text.toLowerCase().includes('want to die'))) {
        const crisisResponse = "**CRISIS RESOURCE ALERT**\n\nIt sounds like you are going through a very difficult time right now. Please know that you are not alone and help is available.\n\n**If you are in immediate danger:**\n• Call **988** (US/Canada Suicide & Crisis Lifeline)\n• Text **HOME to 741741** (Crisis Text Line)\n• Go to your nearest emergency room\n\nPlease reach out to a professional who can support you through this.";
        
        appState.chatMemory.push({ role: 'User', text: text });
        appState.chatMemory.push({ role: 'MindPal', text: crisisResponse });
        saveState();
        
        await appendMessageToUI(crisisResponse, 'bot', true, true);
        setInputState(false);
        if(inputEl) inputEl.focus();
        return; 
    }

    const modeTextEl = document.getElementById('current-mode-text');
    const mode = modeTextEl ? modeTextEl.textContent : 'Active Listen';
    const nameContext = appState.userName !== "Friend" ? `The user's name is ${appState.userName}. ` : "";
    let systemPrompt = `You are MindPal, a highly empathetic mental health companion. ${nameContext}Always respond cleanly and without heavy markdown unless required.`;
    
    if (mode === 'Active Listen') {
        systemPrompt += " Validate the user's input concisely (1-2 sentences max). Do not offer advice. Just listen, reflect, and be warm.";
    } else if (mode === 'Guided Coach') {
        systemPrompt += " Briefly validate, then provide exactly ONE small, objective, actionable step they can take. Keep it short.";
    } else if (mode === 'Cognitive Tools') {
        systemPrompt += " You are a CBT assistant. You MUST structure your response exactly like this, using these exact bold labels:\n\n**Thought:** [Summarize their core negative thought]\n**Distortion:** [Name the cognitive distortion present]\n**Evidence For:** [What objectively supports their thought?]\n**Evidence Against:** [What objectively contradicts their thought?]\n**Balanced Reframe:** [A healthier, more objective way to view it]\n**Next Tiny Action:** [One micro-step they can take right now]";
    }

    const typingId = "status-" + Date.now();
    appendStatusIndicator(typingId);

    const historyToPass = [...appState.chatMemory];
    appState.chatMemory.push({ role: 'User', text: text });

    const responseText = await callGemini(text, systemPrompt, historyToPass);

    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    
    appState.chatMemory.push({ role: 'MindPal', text: responseText });
    saveState();
    
    await appendMessageToUI(responseText, 'bot', true, true); 
    
    setInputState(false);
    if(inputEl) inputEl.focus();
}

async function appendMessageToUI(text, sender, smoothScroll, useTypewriter = false) {
    const chatHistory = document.getElementById('chat-history');
    if (!chatHistory) return;
    const msgDiv = document.createElement('div');
    
    if (sender === 'bot') {
        msgDiv.className = `flex flex-col gap-1 w-full self-start animate-fade-in pl-10`;
        
        const parsed = processCBTResponse(text);
        
        const contentContainer = document.createElement('div');
        contentContainer.className = `flex flex-col text-[15px] text-gemini-text dark:text-gemini-darkText leading-relaxed max-w-3xl w-full`;
        
        if (parsed.timelineHtml) {
            const timelineDiv = document.createElement('div');
            timelineDiv.innerHTML = parsed.timelineHtml;
            contentContainer.appendChild(timelineDiv);
        }

        const contentBox = document.createElement('div');
        contentBox.className = 'content-box';
        if (!useTypewriter) contentBox.innerHTML = parsed.finalHtml;
        
        contentContainer.appendChild(contentBox);
        
        const actionDiv = document.createElement('div');
        actionDiv.className = `flex items-center gap-1 mt-3 text-gray-500 dark:text-[#c4c7c5] action-buttons transition-opacity duration-300 ${useTypewriter ? 'opacity-0' : 'opacity-100'}`;
        actionDiv.innerHTML = `
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
        contentContainer.appendChild(actionDiv);
        
        msgDiv.appendChild(contentContainer);
        chatHistory.appendChild(msgDiv);
        
        lucide.createIcons();

        const header = msgDiv.querySelector('.accordion-header');
        if (header) {
            header.addEventListener('click', function() {
                const content = this.nextElementSibling;
                const chevron = this.querySelector('.chevron-icon');
                const collapsedText = this.querySelector('.collapsed-text');
                const expandedText = this.querySelector('.expanded-text');
                
                const isOpen = content.classList.contains('grid-rows-[1fr]');
                
                if (isOpen) {
                    content.classList.remove('grid-rows-[1fr]', 'opacity-100');
                    content.classList.add('grid-rows-[0fr]', 'opacity-0');
                    chevron.classList.remove('rotate-90');
                    collapsedText.classList.remove('hidden');
                    expandedText.classList.add('hidden');
                } else {
                    content.classList.remove('grid-rows-[0fr]', 'opacity-0');
                    content.classList.add('grid-rows-[1fr]', 'opacity-100');
                    chevron.classList.add('rotate-90');
                    collapsedText.classList.add('hidden');
                    expandedText.classList.remove('hidden');
                    
                    setTimeout(() => {
                        const rect = msgDiv.getBoundingClientRect();
                        const chatRect = chatHistory.getBoundingClientRect();
                        if (rect.bottom > chatRect.bottom) {
                            chatHistory.scrollBy({ top: rect.bottom - chatRect.bottom + 20, behavior: 'smooth' });
                        }
                    }, 300);
                }
            });
        }
        
        if (useTypewriter) {
            await typewriteHTML(contentBox, parsed.finalHtml, chatHistory);
            actionDiv.classList.remove('opacity-0'); 
        } else if (smoothScroll) {
            chatHistory.scrollTo({ top: chatHistory.scrollHeight, behavior: 'smooth' });
        }

        const copyBtn = actionDiv.querySelector('.action-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const textArea = document.createElement("textarea");
                textArea.value = getCleanTextForCopy(text);
                document.body.appendChild(textArea);
                textArea.select();
                try { document.execCommand('copy'); showToast("Copied to clipboard"); } catch (e) {}
                document.body.removeChild(textArea);
            });
        }
        
        const likeBtn = actionDiv.querySelector('.action-like');
        const dislikeBtn = actionDiv.querySelector('.action-dislike');
        if (likeBtn) {
            likeBtn.addEventListener('click', function() {
                this.classList.toggle('text-blue-600');
                this.classList.toggle('dark:text-blue-400');
                if (dislikeBtn) dislikeBtn.classList.remove('text-red-600', 'dark:text-red-400');
            });
        }
        if (dislikeBtn) {
            dislikeBtn.addEventListener('click', function() {
                this.classList.toggle('text-red-600');
                this.classList.toggle('dark:text-red-400');
                if (likeBtn) likeBtn.classList.remove('text-blue-600', 'dark:text-blue-400');
            });
        }
        
        const retryBtn = actionDiv.querySelector('.action-retry');
        if (retryBtn) {
            retryBtn.addEventListener('click', async () => {
                if (isGenerating || appState.chatMemory.length < 2) return;
                
                let lastUserIndex = appState.chatMemory.length - 1;
                while(lastUserIndex >= 0 && appState.chatMemory[lastUserIndex].role !== 'User') lastUserIndex--;
                if(lastUserIndex < 0) return;
                
                const lastUserMsg = appState.chatMemory[lastUserIndex].text;
                
                appState.chatMemory = appState.chatMemory.slice(0, lastUserIndex);
                saveState();
                renderPersistedChat(); 
                
                const inputEl = document.getElementById('chat-input');
                if (inputEl) {
                    inputEl.value = lastUserMsg;
                    inputEl.dispatchEvent(new Event('input'));
                    handleSend();
                }
            });
        }

    } else {
        msgDiv.className = `flex gap-4 w-full justify-end animate-fade-in`;
        msgDiv.innerHTML = `
            <div class="bg-gemini-surface dark:bg-gemini-darkSurface text-gemini-text dark:text-gemini-darkText px-5 py-3 rounded-[24px] max-w-[80%] text-[15px] leading-relaxed">
                ${text}
            </div>
        `;
        chatHistory.appendChild(msgDiv);
        if (smoothScroll) chatHistory.scrollTo({ top: chatHistory.scrollHeight, behavior: 'smooth' });
    }
}

// Initialize App
loadState();