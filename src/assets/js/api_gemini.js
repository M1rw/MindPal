// Gemini API wrapper
window.apiKey = "AQ.Ab8RN6LqmMszxXW5irPT73rg7bGm_3uHDxpNo_KmtTukp8ccig";

window.callGemini = async function(userMessage, systemInstruction, history = []) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${window.apiKey}`;
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
};
