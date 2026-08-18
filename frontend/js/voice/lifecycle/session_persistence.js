export function createVoiceSessionPersistence({
  persist = async () => true,
  onEvent = () => {},
  now = () => Date.now(),
} = {}) {
  let active = null;
  let lastPersistPromise = null;

  function start({ sessionId, incognito = false } = {}) {
    active = {
      sessionId: sessionId || `voice-session-${now().toString(36)}`,
      incognito: Boolean(incognito),
      startedAt: now(),
      endedAt: null,
      completedTurnCount: 0,
      reconnectCount: 0,
      incompleteTurn: false,
      userTranscript: "",
      aiTranscript: "",
    };
    return Object.freeze({ ...active });
  }

  function update(patch = {}) {
    if (!active) return null;
    active = { ...active, ...patch };
    return Object.freeze({ ...active });
  }

  async function close({ reason = "user-stop", ...patch } = {}) {
    if (!active) return null;
    active = {
      ...active,
      ...patch,
      reason,
      endedAt: now(),
      durationMs: Math.max(0, now() - active.startedAt),
    };
    const record = Object.freeze({ ...active });
    active = null;
    if (record.incognito) {
      onEvent({ type: "session.persistence-skipped", reason: "incognito", record });
      return { persisted: false, record };
    }
    lastPersistPromise = Promise.resolve(persist(record))
      .then(() => {
        onEvent({ type: "session.persisted", record });
        return { persisted: true, record };
      })
      .catch((error) => {
        onEvent({ type: "session.persistence-failed", record, error });
        return { persisted: false, record, error };
      });
    return lastPersistPromise;
  }

  return Object.freeze({
    start,
    update,
    close,
    getActive: () => active && Object.freeze({ ...active }),
    getLastPersist: () => lastPersistPromise,
  });
}
