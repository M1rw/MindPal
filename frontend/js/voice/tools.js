export function getToolDeclarations() {
  return [
    {
      name: "get_user_profile",
      description: "Get the current user's profile including their name, communication preferences, tone, language, and response style preferences. Call this when you need to know who you're talking to or how they prefer to be spoken to.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "search_memory",
      description: "Search the user's saved memory for personal facts, relationships, important people (like girlfriend, family), preferences, emotional triggers, goals, coping tools, and past context. Use this when the user asks about something you should remember, or to personalize your response.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "What to search for — e.g. 'girlfriend', 'triggers', 'goals', 'preferences', 'name'" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_recent_chat",
      description: "Get the most recent text chat messages between the user and MindPal. Use this to understand what they were just talking about before starting the voice call, or to continue a previous conversation.",
      parameters: {
        type: "OBJECT",
        properties: {
          count: { type: "INTEGER", description: "Number of recent messages to get (default 10, max 20)" },
        },
      },
    },
    {
      name: "search_chat_history",
      description: "Search through the user's full chat history for messages matching a specific topic or keyword. Use this when the user references a past conversation.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "Text or topic to search for in past messages" },
        },
        required: ["query"],
      },
    },
    {
      name: "current_time",
      description: "Get the current date and time in both UTC and the user's local timezone. ALWAYS use this when the user asks about the time, date, day, or anything time-related. Never guess the time.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "date_calculator",
      description: "Calculate date differences — 'how long ago was X?', 'how many days until Y?', 'what date is N days from now?'. Use this when the user asks about dates, anniversaries, deadlines, or durations.",
      parameters: {
        type: "OBJECT",
        properties: {
          operation: { type: "STRING", description: "One of: 'days_since' (how many days since a date), 'days_until' (how many days until a date), 'add_days' (what date is N days from now)" },
          date: { type: "STRING", description: "Date in YYYY-MM-DD format (for days_since/days_until)" },
          days: { type: "INTEGER", description: "Number of days (for add_days operation)" },
        },
        required: ["operation"],
      },
    },
    {
      name: "web_search",
      description: "Search the web for real-time, current information. Use this when the user asks about current events, recent news, facts you're unsure about, weather, sports scores, or anything that requires up-to-date data from the internet. Returns titles, snippets, and URLs.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "The search query — be specific and concise" },
        },
        required: ["query"],
      },
    },
  ];
}

export function createToolExecutor({ getAuthToken, getAppCheckToken, contextProvider, apiBaseUrl }) {
  return async function executeToolCall(name, args, options = {}) {
    const baseUrl = typeof apiBaseUrl === "function" ? apiBaseUrl() : apiBaseUrl || "";
    const token = await Promise.resolve(typeof getAuthToken === "function" ? getAuthToken() : getAuthToken);
    const appCheckToken = await Promise.resolve(typeof getAppCheckToken === "function" ? getAppCheckToken() : getAppCheckToken);

    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (appCheckToken) headers["X-Firebase-AppCheck"] = appCheckToken;

    const controller = new AbortController();
    const externalSignal = options.signal || null;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener?.("abort", abortFromExternal, { once: true });
    const timeoutId = setTimeout(() => controller.abort(new DOMException("Tool timed out", "TimeoutError")), options.timeoutMs || 12_000);
    const allowClientFallback = options.allowClientFallback !== false;

    try {
      const response = await fetch(`${baseUrl}/tools/execute`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tool: name, args }),
        signal: controller.signal,
        credentials: "omit",
      });

      if (!response.ok) {
        console.warn(`[TOOL_CALL] ${name} backend returned HTTP ${response.status}`);
        if (!allowClientFallback) {
          return { error: `Tool backend returned HTTP ${response.status}` };
        }
        const provider = typeof contextProvider === "function" ? contextProvider() : contextProvider;
        return executeToolClientSide(name, args, provider);
      }

      const data = await response.json();
      const result = data.result || data;
      console.info(`[TOOL_CALL] ${name} executed via BACKEND`, result?.result_count ? `(${result.result_count} results)` : "");
      return result;
    } catch (err) {
      const isAbort = err.name === "AbortError" || err.name === "TimeoutError";
      console.warn(`[TOOL_CALL] ${name} backend failed: ${isAbort ? "timeout/cancelled" : err.message}`);
      if (!allowClientFallback) {
        return { error: isAbort ? "Tool request timed out" : "Tool backend unavailable" };
      }
      const provider = typeof contextProvider === "function" ? contextProvider() : contextProvider;
      return executeToolClientSide(name, args, provider);
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener?.("abort", abortFromExternal);
    }
  };
}

export function executeToolClientSide(name, args, contextProvider) {
  if (name === "current_time") {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const utcOff = -now.getTimezoneOffset();
    const offH = Math.floor(Math.abs(utcOff) / 60);
    const offM = Math.abs(utcOff) % 60;
    return {
      local_time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }),
      local_date: now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      timezone: tz,
      utc_offset: `UTC${utcOff >= 0 ? '+' : '-'}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`,
      day_of_week: now.toLocaleDateString('en', { weekday: 'long' }),
      iso: now.toISOString(),
    };
  }

  if (!contextProvider) return { error: "No context available" };

  switch (name) {
    case "get_user_profile": {
      const profile = contextProvider.getUserProfile?.() || {};
      return {
        name: profile.name || "unknown",
        preferences: profile.preferences || {},
        communication: profile.communication || {},
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
      };
    }
    case "search_memory": {
      const query = String(args.query || "").toLowerCase();
      const allLines = contextProvider.getMemoryLines?.() || [];
      if (!query) return { facts: allLines.slice(0, 15) };
      const matching = allLines.filter((line) => line.toLowerCase().includes(query));
      return {
        query,
        facts: matching.length ? matching.slice(0, 15) : allLines.slice(0, 10),
        matchCount: matching.length,
      };
    }
    case "get_recent_chat": {
      const count = Math.min(Math.max(1, args.count || 10), 20);
      const messages = contextProvider.getRecentChat?.(count) || [];
      return {
        messages: messages.map((m) => ({
          from: m.role === "User" ? "user" : "mindpal",
          text: String(m.text || "").slice(0, 300),
          time: m.createdAt || "",
        })),
      };
    }
    case "search_chat_history": {
      const query = String(args.query || "").toLowerCase();
      if (!query) return { results: [], query };
      const all = contextProvider.searchChat?.(query) || [];
      return {
        query,
        results: all.slice(0, 10).map((m) => ({
          from: m.role === "User" ? "user" : "mindpal",
          text: String(m.text || "").slice(0, 300),
          time: m.createdAt || "",
        })),
        totalMatches: all.length,
      };
    }
    case "web_search":
      console.info(`[TOOL_CALL] web_search falling back to CLIENT-SIDE DDG for: "${args.query || ""}"`);
      return clientSideWebSearch(args.query || "");
    case "date_calculator":
      return { error: "Date calculator is temporarily unavailable. Please calculate the date manually from the current time context." };
    default:
      return { error: `Tool ${name} is not available right now. Please respond without it.` };
  }
}

export async function clientSideWebSearch(query) {
  if (!query) return { error: "Search query is required" };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return { error: "Search temporarily unavailable" };

    const data = await res.json();
    const results = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.AbstractSource || "DuckDuckGo",
        snippet: data.AbstractText.slice(0, 300),
        url: data.AbstractURL,
      });
    }

    if (data.Answer) {
      results.push({ title: "Direct Answer", snippet: String(data.Answer).slice(0, 300), url: "" });
    }

    for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
      if (topic && topic.Text && topic.FirstURL) {
        results.push({ title: topic.Text.split(" - ")[0].slice(0, 80), snippet: topic.Text.slice(0, 200), url: topic.FirstURL });
      }
    }

    if (!results.length) {
      return { query, results: [], note: "No instant results found. Try rephrasing the query." };
    }

    return { query, results, result_count: results.length, source: "client_fallback" };
  } catch (err) {
    return { error: "Search temporarily unavailable — " + (err.name === "AbortError" ? "timeout" : "network error") };
  }
}
