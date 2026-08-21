import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createVoiceV3App, type VoiceProviderMode, type VoiceV3App } from "./app";
import { DebugPanel } from "./debug/DebugPanel";
import { ErrorBoundary } from "./debug/ErrorBoundary";
import { DEFAULT_VOICE_V3_FEATURE_FLAGS } from "./integration/feature-flags";

const REVIEW_PERSONAS = ["Kore", "Charon"] as const;
const REVIEW_CUES = ["mhm", "yeah", "aha", "right", "okay"] as const;
type ReviewStatus = "unreviewed" | "pass" | "fail" | "unsure";
type ReviewResult = { status: ReviewStatus; comments: string; requested: boolean; scheduled: boolean };
type ReviewMap = Record<string, ReviewResult>;
type ReviewSession = { app: VoiceV3App; persona: string };

function VoiceV3DebugApp() {
  const [providerMode, setProviderMode] = useState<VoiceProviderMode>("mock");
  const [app, setApp] = useState<VoiceV3App>(() => createVoiceV3App({ providerMode: "mock" }));

  useEffect(() => () => app.dispose(), [app]);

  const toggleProvider = () => {
    const nextMode: VoiceProviderMode = providerMode === "mock" ? "real" : "mock";
    app.dispose();
    const nextApp = createVoiceV3App({ providerMode: nextMode });
    setProviderMode(nextMode);
    setApp(nextApp);
  };

  return (
    <DebugPanel
      bus={app.bus}
      app={app}
      captureManager={app.captureManager}
      providerMode={providerMode}
      onToggleProvider={toggleProvider}
    />
  );
}

function VoiceV3ReviewPage() {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [activePersona, setActivePersona] = useState<string | null>(null);
  const [activeCueKey, setActiveCueKey] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ReviewMap>(() => createInitialReviews());
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const activeCueKeyRef = useRef<string | null>(null);

  useEffect(() => {
    activeCueKeyRef.current = activeCueKey;
  }, [activeCueKey]);

  useEffect(() => {
    if (!session) return;
    const unsubscribe = session.app.bus.subscribe((envelope) => {
      if (envelope.messageType === "playback.scheduled") {
        const payload = envelope.payload as { readonly lane?: unknown };
        if (payload.lane === "backchannel") {
          const key = activeCueKeyRef.current;
          if (key) setReviews((current) => ({ ...current, [key]: { ...current[key], scheduled: true } }));
        }
      }
      if (envelope.messageType === "playback.error" || envelope.messageType === "transport.error") {
        setEvents((current) => [...current.slice(-7), envelope.messageType]);
      }
    }, {});
    return unsubscribe;
  }, [session]);

  useEffect(() => () => {
    session?.app.dispose();
  }, [session]);

  const startSession = async (persona: string): Promise<void> => {
    session?.app.dispose();
    const nextApp = createVoiceV3App({
      providerMode: "real",
      productionMode: true,
      voicePersona: persona,
      // The review route is an explicitly gated internal harness. Production
      // users still inherit the normal disabled-by-default V3 flag state.
      featureFlags: { ...DEFAULT_VOICE_V3_FEATURE_FLAGS, VOICE_V3_ENABLED: true },
    });
    setError(null);
    setEvents([]);
    setActivePersona(null);
    setSession(null);
    try {
      await nextApp.start({ startCapture: false });
      if (!nextApp.transportManager.isReady) {
        throw new Error("Gemini Live transport did not complete setup");
      }
      setActivePersona(persona);
      setSession({ app: nextApp, persona });
      setEvents([`Gemini Live ready · ${persona}`]);
    } catch (reason: unknown) {
      nextApp.dispose();
      setSession(null);
      setActivePersona(null);
      setError(reason instanceof Error ? reason.message : "Gemini Live session failed to start");
    }
  };

  const stopSession = async (): Promise<void> => {
    if (!session) return;
    await session.app.stop().catch(() => undefined);
    session.app.dispose();
    setSession(null);
    setActiveCueKey(null);
  };

  const requestCue = (cue: string): void => {
    if (!session) return;
    const key = `${session.persona}:${cue}`;
    const sent = session.app.requestGeminiNativeCue(cue);
    setActiveCueKey(sent ? key : null);
    setReviews((current) => ({
      ...current,
      [key]: { ...current[key], requested: sent, scheduled: false },
    }));
    if (!sent) setError("Gemini Live is not ready; start a persona session first.");
  };

  const updateReview = (key: string, patch: Partial<ReviewResult>): void => {
    setReviews((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  };

  const allPassed = Object.values(reviews).every((review) => review.status === "pass");
  const allScheduled = Object.values(reviews).every((review) => review.scheduled);
  const decision = allPassed && allScheduled ? "GO" : "PENDING";

  const exportReview = (): void => {
    const payload = {
      generatedAt: new Date().toISOString(),
      source: "Gemini Native Audio Live session",
      camBRequired: false,
      personas: REVIEW_PERSONAS.map((persona) => ({
        persona,
        voiceName: persona,
        cues: REVIEW_CUES.map((cue) => ({ cue, review: reviews[`${persona}:${cue}`] })),
      })),
      decision,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `voice-v3-gemini-review-${new Date().toISOString().replaceAll(":", "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main style={{ minHeight: "100vh", background: "#0b1020", color: "#e2e8f0", padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "start", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>MindPal Voice V3 — Gemini Human Review</h1>
            <p style={{ color: "#94a3b8" }}>Review Kore and Charon from the same Gemini Native Audio Live session used for normal assistant speech.</p>
          </div>
          <button type="button" onClick={exportReview}>Export review JSON</button>
        </header>
        <section style={{ padding: 16, border: "1px solid #334155", borderRadius: 12, marginBottom: 20 }}>
          <strong>Decision: <span style={{ color: decision === "GO" ? "#86efac" : "#fbbf24" }}>{decision}</span></strong>
          <span style={{ marginLeft: 16, color: "#94a3b8" }}>Gemini-only · CAMB required: no · Scheduled cues: {allScheduled ? "yes" : "pending"}</span>
        </section>
        <section style={{ padding: 16, border: "1px solid #334155", borderRadius: 12, marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>Live session</h2>
          <p style={{ color: "#94a3b8" }}>Start one persona, then play each cue. Every cue is sent as a constrained realtime text request to the active Gemini session; returned audio is routed as a backchannel lane and does not create a separate CAMB voice.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {REVIEW_PERSONAS.map((persona) => <button key={persona} type="button" disabled={session !== null} onClick={() => void startSession(persona)}>Start {persona}</button>)}
            <button type="button" disabled={!session} onClick={() => void stopSession()}>Stop session</button>
          </div>
          <p>Active persona: <strong>{activePersona ?? "none"}</strong>{events.length > 0 ? ` · ${events.at(-1)}` : ""}</p>
          {error && <p style={{ color: "#fca5a5" }}>{error}</p>}
        </section>
        {REVIEW_PERSONAS.map((persona) => <section key={persona} style={{ padding: 18, border: "1px solid #334155", borderRadius: 12, marginBottom: 18 }}>
          <h2 style={{ marginTop: 0 }}>{persona}</h2>
          <p>Gemini voice mapping: <strong style={{ color: "#86efac" }}>configured · prebuilt voice name `{persona}`</strong></p>
          <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th align="left">Cue</th><th align="left">Request</th><th align="left">Playback</th><th align="left">Review</th><th align="left">Comments</th></tr></thead><tbody>{REVIEW_CUES.map((cue) => {
            const key = `${persona}:${cue}`;
            const review = reviews[key];
            return <tr key={key}>
              <td style={{ padding: "10px 6px" }}>{cue}</td>
              <td style={{ padding: "10px 6px" }}><button type="button" disabled={!session || session.persona !== persona} onClick={() => requestCue(cue)}>{activeCueKey === key ? "Requested" : "Play via Gemini"}</button></td>
              <td style={{ padding: "10px 6px" }}>{review.scheduled ? "scheduled" : review.requested ? "waiting" : "—"}</td>
              <td style={{ padding: "10px 6px" }}><select value={review.status} onChange={(event) => updateReview(key, { status: event.target.value as ReviewStatus })}><option value="unreviewed">unreviewed</option><option value="pass">pass</option><option value="fail">fail</option><option value="unsure">unsure</option></select></td>
              <td style={{ padding: "10px 6px" }}><input value={review.comments} onChange={(event) => updateReview(key, { comments: event.target.value })} placeholder="tone, clarity, artifacts…" /></td>
            </tr>;
          })}</tbody></table></div>
        </section>)}
        <p style={{ color: "#64748b" }}>No production rollout is performed from this page. Save review JSON under <code>artifacts/voice-persona-review/</code>. This page intentionally contains no provider API keys or external voice IDs.</p>
      </div>
    </main>
  );
}

function createInitialReviews(): ReviewMap {
  return Object.fromEntries(REVIEW_PERSONAS.flatMap((persona) => REVIEW_CUES.map((cue) => [`${persona}:${cue}`, { status: "unreviewed", comments: "", requested: false, scheduled: false }])));
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Voice V3 debug root element was not found");

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      {window.location.pathname === "/voice-v3-review" ? <VoiceV3ReviewPage /> : <VoiceV3DebugApp />}
    </ErrorBoundary>
  </StrictMode>,
);
