with open('frontend/js/api.js', 'a', encoding='utf-8') as f:
    f.write('''

export async function sendChatMessageStream({
  message,
  history = [],
  locale = "en",
  channel = "web",
  mode = "Active Listen",
  token = null,
  profileContext = null,
  onChunk = (text) => {},
  onMetadata = (meta) => {},
  onError = (error) => {}
}) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) throw new Error("Message cannot be empty");

  const backendPreference = MODE_UI_TO_BACKEND[mode] || "active_listen";
  const normalizedHistory = normalizeChatHistory(history, 60, "content");
  const metadata = { locale, mode: backendPreference, ...(profileContext?.settingsMetadata || {}) };

  const url = "/api/chat/stream";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: cleanMessage, history: normalizedHistory, metadata, stream: true }),
    });

    if (!response.ok) {
      throw new Error(`Stream error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (dataStr) {
            try {
              const data = JSON.parse(dataStr);
              if (data.error) {
                onError(new Error(data.error));
              } else if (data.text !== undefined) {
                onChunk(data.text);
              } else if (data.type === 'metadata') {
                onMetadata(data);
              }
            } catch (e) {
              console.warn("Failed to parse SSE chunk", dataStr);
            }
          }
        }
      }
    }
  } catch (error) {
    onError(error);
    throw error;
  }
}
''')
