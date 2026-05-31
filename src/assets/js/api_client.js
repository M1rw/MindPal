// Lightweight HTTP helpers and client-side wrapper for server LLM proxy
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

    // callServerAsk posts message+context to a server-side /api/ask proxy.
    // Server should call the LLM with the API key; client must not hold the key.
    async function callServerAsk(userMessage, systemInstruction, history = []) {
        try {
            const payload = { userMessage, systemInstruction, history };
            const data = await postJSON('/api/ask', payload, { timeout: 60000 });
            // Expecting { text: '...' } or similar shape from server
            if (data && (data.text || data.response)) return data.text || data.response;
            // Fallback: if server returns Gemini response shape
            if (data && data.candidates && data.candidates[0] && data.candidates[0].content) {
                return data.candidates[0].content.parts?.[0]?.text || '';
            }
            return '';
        } catch (e) {
            console.error('callServerAsk error', e);
            return 'System offline. Please try again.';
        }
    }

    window.postJSON = postJSON;
    window.callServerAsk = callServerAsk;
})();
