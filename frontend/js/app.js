const body = document.body;
const themeToggle = document.getElementById("theme-toggle");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const clearBtn = document.getElementById("clear-btn");
const chatHistory = document.getElementById("chat-history");
const chips = document.querySelectorAll(".chip");

const THEME_KEY = "mindpal_theme";

function setTheme(mode) {
    if (mode === "dark") {
        body.classList.add("theme-dark");
    } else {
        body.classList.remove("theme-dark");
    }
    localStorage.setItem(THEME_KEY, mode);
}

function toggleTheme() {
    const isDark = body.classList.contains("theme-dark");
    setTheme(isDark ? "light" : "dark");
}

function createMessage(text, role) {
    const wrapper = document.createElement("div");
    wrapper.className = `message ${role}`;

    if (role === "user") {
        wrapper.innerHTML = `
            <div>
                <div class="bubble">${text}</div>
                <div class="meta">You</div>
            </div>
        `;
        return wrapper;
    }

    wrapper.innerHTML = `
        <div class="avatar">M</div>
        <div>
            <div class="bubble">${text}</div>
            <div class="meta">MindPal</div>
        </div>
    `;
    return wrapper;
}

function addMessage(text, role) {
    const message = createMessage(text, role);
    chatHistory.appendChild(message);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function simulateReply() {
    const typing = createMessage("Thinking with you...", "assistant");
    chatHistory.appendChild(typing);
    chatHistory.scrollTop = chatHistory.scrollHeight;

    window.setTimeout(() => {
        typing.remove();
        addMessage("Thanks for sharing. Want to pick one small thing we can do next?", "assistant");
    }, 800);
}

function handleSend() {
    const text = chatInput.value.trim();
    if (!text) return;
    addMessage(text, "user");
    chatInput.value = "";
    simulateReply();
}

function handleClear() {
    chatHistory.innerHTML = "";
    addMessage("Hey, I&#39;m here. What&#39;s on your mind?", "assistant");
}

const savedTheme = localStorage.getItem(THEME_KEY) || "light";
setTheme(savedTheme);

if (themeToggle) themeToggle.addEventListener("click", toggleTheme);
if (sendBtn) sendBtn.addEventListener("click", handleSend);
if (clearBtn) clearBtn.addEventListener("click", handleClear);

if (chatInput) {
    chatInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            handleSend();
        }
    });
}

chips.forEach((chip) => {
    chip.addEventListener("click", () => {
        const fill = chip.dataset.fill;
        if (!fill) return;
        chatInput.value = fill;
        chatInput.focus();
    });
});
