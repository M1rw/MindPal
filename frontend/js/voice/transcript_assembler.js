function clean(value, maxChars = 8_000) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export function createTranscriptAssembler({ maxChars = 8_000 } = {}) {
  let value = "";
  let lastEventKey = "";
  let sequence = 0;

  function reset() {
    value = "";
    lastEventKey = "";
    sequence = 0;
    return value;
  }

  function append(text, { mode = "auto", eventKey = "" } = {}) {
    const incoming = clean(text, maxChars);
    if (!incoming) return value;
    if (eventKey && eventKey === lastEventKey) return value;
    if (eventKey) lastEventKey = eventKey;

    if (!value) {
      value = incoming;
      sequence += 1;
      return value;
    }
    if (mode === "snapshot" || (mode === "auto" && incoming.startsWith(value))) {
      value = incoming;
      sequence += 1;
      return value;
    }
    if (incoming === value || value.endsWith(incoming)) return value;
    if (mode === "snapshot" && value.startsWith(incoming)) return value;

    const separator = /[\s\u2000-\u200A]$/.test(value) || /^[\s\u2000-\u200A]/.test(incoming) ? "" : " ";
    value = clean(`${value}${separator}${incoming}`, maxChars);
    sequence += 1;
    return value;
  }

  function finalize(text = "") {
    if (text) append(text, { mode: "auto" });
    return value;
  }

  return Object.freeze({
    append,
    finalize,
    reset,
    getText: () => value,
    getSequence: () => sequence,
  });
}
