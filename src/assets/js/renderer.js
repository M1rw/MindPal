// Message rendering utilities
window.appendStatusIndicator = function(id) {
    const chatHistory = document.getElementById('chat-history');
    if (!chatHistory) return;
    const msgDiv = document.createElement('div');
    msgDiv.id = id;
    msgDiv.className = `flex w-full animate-fade-in pl-10`;
    msgDiv.innerHTML = `
        <div class="text-[15px] font-medium shimmer-text">Thought for a few seconds...</div>
    `;
    chatHistory.appendChild(msgDiv);
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    chatHistory.scrollTo({ top: chatHistory.scrollHeight, behavior: 'smooth' });
};

window.formatMarkdown = function(text) {
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong class="text-gray-900 dark:text-gray-100 font-semibold">$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>');
};

window.getCleanTextForCopy = function(text) {
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
};

window.processCBTResponse = function(text) {
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

            if (!reframe) return { timelineHtml: '', finalHtml: window.formatMarkdown(text) };

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
                                    <div class="leading-relaxed"><strong class="text-gray-900 dark:text-white font-semibold">Core Thought:</strong> ${window.formatMarkdown(thought)}</div>
                                </div>` : ''}

                                ${distortion ? `
                                <div class="relative">
                                    <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
                                        <i data-lucide="circle-minus" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
                                    </div>
                                    <div class="leading-relaxed"><strong class="text-gray-900 dark:text-white font-semibold">Distortion Detected:</strong> ${window.formatMarkdown(distortion)}</div>
                                </div>` : ''}

                                ${(evFor || evAgainst) ? `
                                <div class="relative">
                                    <div class="absolute -left-[33px] top-0 bg-gemini-bg dark:bg-gemini-darkBg py-1">
                                        <i data-lucide="circle-minus" class="w-4 h-4 text-gray-400 dark:text-[#c4c7c5]"></i>
                                    </div>
                                    <div class="leading-relaxed space-y-1">
                                        <strong class="text-gray-900 dark:text-white font-semibold block mb-1">Evidence Review:</strong>
                                        ${evFor ? `<div><span class="text-gray-500 dark:text-[#c4c7c5]">For:</span> ${window.formatMarkdown(evFor)}</div>` : ''}
                                        ${evAgainst ? `<div><span class="text-gray-500 dark:text-[#c4c7c5]">Against:</span> ${window.formatMarkdown(evAgainst)}</div>` : ''}
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

            let finalHtml = `<div class="text-[15px] leading-relaxed mb-4">${window.formatMarkdown(reframe)}</div>`;
            if (action) {
                finalHtml += `<div class="mt-4"><strong class="text-gray-900 dark:text-white font-semibold">Next Action:</strong> ${window.formatMarkdown(action)}</div>`;
            }

            return { timelineHtml, finalHtml };
        } catch (e) {
            return { timelineHtml: '', finalHtml: window.formatMarkdown(text) };
        }
    }
    return { timelineHtml: '', finalHtml: window.formatMarkdown(text) };
};

window.typewriteHTML = async function(element, html, scrollContainer) {
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
};

window.appendMessageToUI = async function(text, sender, smoothScroll, useTypewriter = false) {
    const chatHistory = document.getElementById('chat-history');
    if (!chatHistory) return;
    const msgDiv = document.createElement('div');

    if (sender === 'bot') {
        msgDiv.className = `flex flex-col gap-1 w-full self-start animate-fade-in pl-10`;

        const parsed = window.processCBTResponse ? window.processCBTResponse(text) : { timelineHtml: '', finalHtml: window.formatMarkdown(text) };

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

        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();

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
            await window.typewriteHTML(contentBox, parsed.finalHtml, chatHistory);
            actionDiv.classList.remove('opacity-0');
        } else if (smoothScroll) {
            chatHistory.scrollTo({ top: chatHistory.scrollHeight, behavior: 'smooth' });
        }

        const copyBtn = actionDiv.querySelector('.action-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const textArea = document.createElement("textarea");
                textArea.value = window.getCleanTextForCopy(text);
                document.body.appendChild(textArea);
                textArea.select();
                try { document.execCommand('copy'); if (window.showToast) window.showToast("Copied to clipboard"); } catch (e) {}
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
                if (window.isGenerating || window.appState.chatMemory.length < 2) return;

                let lastUserIndex = window.appState.chatMemory.length - 1;
                while(lastUserIndex >= 0 && window.appState.chatMemory[lastUserIndex].role !== 'User') lastUserIndex--;
                if(lastUserIndex < 0) return;

                const lastUserMsg = window.appState.chatMemory[lastUserIndex].text;

                window.appState.chatMemory = window.appState.chatMemory.slice(0, lastUserIndex);
                if (window.saveState) window.saveState();
                if (window.renderPersistedChat) window.renderPersistedChat();

                const inputEl = document.getElementById('chat-input');
                if (inputEl) {
                    inputEl.value = lastUserMsg;
                    inputEl.dispatchEvent(new Event('input'));
                    if (window.handleSend) window.handleSend();
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
};
