// Interaction, input, and messaging
(function() {
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
                if (voiceBtn) voiceBtn.classList.add('hidden');
                if (sendBtn) {
                    sendBtn.classList.remove('hidden');
                    sendBtn.disabled = window.isGenerating;
                }
            } else {
                if (voiceBtn) voiceBtn.classList.remove('hidden');
                if (sendBtn) {
                    sendBtn.classList.add('hidden');
                    sendBtn.disabled = true;
                }
            }
        });

        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (sendBtn && !sendBtn.disabled && !window.isGenerating) window.handleSend && window.handleSend();
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
                if (!window.isGenerating) window.handleSend && window.handleSend();
            }
        });
    });

    if (sendBtn) {
        sendBtn.addEventListener('click', () => {
            if (!window.isGenerating) window.handleSend && window.handleSend();
        });
    }

    // --- CRISIS INTERCEPTION CHECK ---
    window.handleSend = async function() {
        if (window.isGenerating) return;
        const text = inputEl ? inputEl.value.trim() : '';
        if (!text) return;

        if (window.setInputState) window.setInputState(true);

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

        await window.appendMessageToUI && window.appendMessageToUI(text, 'user', true, false);

        if (inputEl) {
            inputEl.value = '';
            inputEl.style.height = 'auto';
            inputEl.dispatchEvent(new Event('input'));
        }

        if (window.appState.crisisMode && (text.toLowerCase().includes('suicide') || text.toLowerCase().includes('kill myself') || text.toLowerCase().includes('want to die'))) {
            const crisisResponse = "**CRISIS RESOURCE ALERT**\n\nIt sounds like you are going through a very difficult time right now. Please know that you are not alone and help is available.\n\n**If you are in immediate danger:**\n• Call **988** (US/Canada Suicide & Crisis Lifeline)\n• Text **HOME to 741741** (Crisis Text Line)\n• Go to your nearest emergency room\n\nPlease reach out to a professional who can support you through this.";

            window.appState.chatMemory.push({ role: 'User', text: text });
            window.appState.chatMemory.push({ role: 'MindPal', text: crisisResponse });
            if (window.saveState) window.saveState();

            await window.appendMessageToUI && window.appendMessageToUI(crisisResponse, 'bot', true, true);
            if (window.setInputState) window.setInputState(false);
            if (inputEl) inputEl.focus();
            return;
        }

        const modeTextEl = document.getElementById('current-mode-text');
        const mode = modeTextEl ? modeTextEl.textContent : 'Active Listen';
        let systemPrompt = "You are MindPal, a highly empathetic mental health companion. Always respond cleanly and without heavy markdown unless required.";

        if (mode === 'Active Listen') {
            systemPrompt += " Validate the user's input concisely (1-2 sentences max). Do not offer advice. Just listen, reflect, and be warm.";
        } else if (mode === 'Guided Coach') {
            systemPrompt += " Briefly validate, then provide exactly ONE small, objective, actionable step they can take. Keep it short.";
        } else if (mode === 'Cognitive Tools') {
            systemPrompt += " You are a CBT assistant. You MUST structure your response exactly like this, using these exact bold labels:\n\n**Thought:** [Summarize their core negative thought]\n**Distortion:** [Name the cognitive distortion present]\n**Evidence For:** [What objectively supports their thought?]\n**Evidence Against:** [What objectively contradicts their thought?]\n**Balanced Reframe:** [A healthier, more objective way to view it]\n**Next Tiny Action:** [One micro-step they can take right now]";
        }

        const typingId = "status-" + Date.now();
        if (window.appendStatusIndicator) window.appendStatusIndicator(typingId);

        const historyToPass = [...window.appState.chatMemory];
        window.appState.chatMemory.push({ role: 'User', text: text });

        const responseText = await (window.callServerAsk ? window.callServerAsk(text, systemPrompt, historyToPass) : (window.callGemini ? window.callGemini(text, systemPrompt, historyToPass) : ""));

        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        window.appState.chatMemory.push({ role: 'MindPal', text: responseText });
        if (window.saveState) window.saveState();

        await window.appendMessageToUI && window.appendMessageToUI(responseText, 'bot', true, true);

        if (window.setInputState) window.setInputState(false);
        if (inputEl) inputEl.focus();
    };
})();
