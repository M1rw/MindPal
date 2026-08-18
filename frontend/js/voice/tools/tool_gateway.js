const LOCAL_TOOLS = new Set(["current_time"]);
const VERIFIED_FACT_TOOLS = new Set(["web_search", "verify_current_fact"]);

function normalizeError(error) {
  if (!error) return "tool-failed";
  if (typeof error === "string") return error;
  return error.message || "tool-failed";
}

export function classifyVoiceTool(name) {
  if (LOCAL_TOOLS.has(name)) return "local";
  if (VERIFIED_FACT_TOOLS.has(name)) return "verified-evidence";
  return "backend";
}

export function createVoiceToolGateway({
  localExecutor = null,
  backendExecutor = null,
  evidenceExecutor = null,
  onEvent = () => {},
} = {}) {
  async function execute(name, args = {}, {
    identity = null,
    signal = null,
    timeoutMs = 12_000,
  } = {}) {
    const category = classifyVoiceTool(name);
    onEvent({ type: "tool.started", name, category, identity });
    const executor = category === "local"
      ? localExecutor
      : category === "verified-evidence"
        ? evidenceExecutor
        : backendExecutor;
    if (typeof executor !== "function") {
      const result = { error: `No ${category} executor configured for ${name}` };
      onEvent({ type: "tool.failed", name, category, identity, error: result.error });
      return result;
    }

    try {
      const result = await executor(name, args, { identity, signal, timeoutMs, allowClientFallback: false });
      const normalized = result || { error: "empty-tool-result" };
      onEvent({ type: normalized.error ? "tool.failed" : "tool.resolved", name, category, identity, result: normalized });
      return normalized;
    } catch (error) {
      const normalized = { error: normalizeError(error) };
      onEvent({ type: "tool.failed", name, category, identity, error: normalized.error });
      return normalized;
    }
  }

  return Object.freeze({ execute, classify: classifyVoiceTool });
}

export { LOCAL_TOOLS, VERIFIED_FACT_TOOLS };
