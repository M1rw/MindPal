/* Lightweight API client — minimal runtime for mindpal.html

Keep this file small: it exposes the core helpers used by the live UI.
- `postJSON(url, body, opts)`: POST JSON helper with timeout.
- `fetchJSON(url, opts)`: GET helper that returns parsed JSON.
- `callServerAsk(text, mode, history)`: Primary server-side LLM proxy (/api/ask).

Removed other, unused wrappers to keep the client bundle minimal.
*/
(function() {
    async function postJSON(url, body, opts = {}) {
        const controller = new AbortController();
        const timeout = opts.timeout || 30000;
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timer);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${text}`);
            }
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async function fetchJSON(url, opts = {}) {
        const controller = new AbortController();
        const timeout = opts.timeout || 30000;
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${text}`);
            }
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    window.postJSON = postJSON;
    window.fetchJSON = fetchJSON;
})();
