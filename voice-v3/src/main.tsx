import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createVoiceV3App, type VoiceProviderMode, type VoiceV3App } from "./app";
import { DebugPanel } from "./debug/DebugPanel";
import { ErrorBoundary } from "./debug/ErrorBoundary";
import { parseRealtimeTtsResponse, REALTIME_TTS_ENDPOINT, type RealtimeTtsResponse } from "./integration/tts-endpoint-contract";

const REVIEW_PERSONAS = ["Kore", "Charon"] as const;
const REVIEW_CUES = ["mhm", "yeah", "aha", "right", "okay"] as const;
type ReviewStatus = "unreviewed" | "pass" | "fail" | "unsure";
type ReviewResult = { status: ReviewStatus; comments: string };
type PersonaMetadata = { persona: string; tts_provider: string; voice_id: string; gender: string; style: string };
type CatalogResponse = { persona_voice_catalog?: Record<string, PersonaMetadata>; fallback_policy?: string };
type LoadedSample = { response: RealtimeTtsResponse; pcm: Int16Array | null; fetchedAt: string };

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
  const [catalog, setCatalog] = useState<Record<string, PersonaMetadata>>({});
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [samples, setSamples] = useState<Record<string, LoadedSample>>({});
  const [loadingPersona, setLoadingPersona] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, ReviewResult>>({});
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/voice/v3/personas", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Persona catalog request failed (${response.status})`);
        return (await response.json()) as unknown;
      })
      .then((value) => {
        if (!active) return;
        const candidate = value as CatalogResponse;
        setCatalog(candidate.persona_voice_catalog ?? {});
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(error instanceof Error ? error.message : "Persona catalog unavailable");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    void audioContextRef.current?.close();
  }, []);

  const loadPersonaSamples = async (persona: string): Promise<void> => {
    setLoadingPersona(persona);
    setSampleError(null);
    try {
      for (const cue of REVIEW_CUES) {
        const response = await fetch(REALTIME_TTS_ENDPOINT, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: cue, persona, emotion: "neutral", format: "pcm16", sampleRate: 24_000 }),
        });
        if (!response.ok) throw new Error(`${persona}/${cue} failed (${response.status})`);
        const parsed = parseRealtimeTtsResponse(await response.json() as unknown);
        setSamples((current) => ({
          ...current,
          [`${persona}:${cue}`]: { response: parsed, pcm: parsed.audioBase64 ? decodePcm16(parsed.audioBase64) : null, fetchedAt: new Date().toISOString() },
        }));
      }
    } catch (error: unknown) {
      setSampleError(error instanceof Error ? error.message : "Sample generation failed");
    } finally {
      setLoadingPersona(null);
    }
  };

  const playSample = async (sample: LoadedSample): Promise<void> => {
    if (!sample.pcm) return;
    const context = audioContextRef.current ?? new AudioContext();
    audioContextRef.current = context;
    if (context.state === "suspended") await context.resume();
    const buffer = context.createBuffer(1, sample.pcm.length, 24_000);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sample.pcm.length; index += 1) channel[index] = (sample.pcm[index] ?? 0) / 32_768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  };

  const updateReview = (key: string, patch: Partial<ReviewResult>): void => {
    setReviews((current) => ({
      ...current,
      [key]: { status: current[key]?.status ?? "unreviewed", comments: current[key]?.comments ?? "", ...patch },
    }));
  };

  const configured = REVIEW_PERSONAS.every((persona) => catalog[persona]?.voice_id && catalog[persona]?.voice_id !== "REQUIRED");
  const reviewKeys = REVIEW_PERSONAS.flatMap((persona) => REVIEW_CUES.map((cue) => `${persona}:${cue}`));
  const allLoaded = reviewKeys.every((key) => samples[key]);
  const allPassed = reviewKeys.every((key) => reviews[key]?.status === "pass");
  const decision = !configured ? "NO-GO" : allLoaded && allPassed ? "GO" : "PENDING";

  const exportReview = (): void => {
    const payload = {
      generatedAt: new Date().toISOString(),
      personas: REVIEW_PERSONAS.map((persona) => ({ metadata: catalog[persona] ?? null, samples: REVIEW_CUES.map((cue) => ({ cue, sample: samples[`${persona}:${cue}`]?.response ?? null, review: reviews[`${persona}:${cue}`] ?? { status: "unreviewed", comments: "" } })) })),
      decision,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `voice-v3-persona-review-${new Date().toISOString().replaceAll(":", "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main style={{ minHeight: "100vh", background: "#0b1020", color: "#e2e8f0", padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "start", flexWrap: "wrap" }}>
          <div><h1 style={{ margin: 0 }}>MindPal Voice V3 — Human Voice Review</h1><p style={{ color: "#94a3b8" }}>Internal listening gate for explicit persona mappings and short conversational cues.</p></div>
          <button type="button" onClick={exportReview}>Export review JSON</button>
        </header>
        <section style={{ padding: 16, border: "1px solid #334155", borderRadius: 12, marginBottom: 20 }}>
          <strong>Decision: <span style={{ color: decision === "GO" ? "#86efac" : decision === "NO-GO" ? "#fca5a5" : "#fbbf24" }}>{decision}</span></strong>
          <span style={{ marginLeft: 16, color: "#94a3b8" }}>Configured: {configured ? "yes" : "no"} · Samples loaded: {allLoaded ? "yes" : "no"} · All cues passed: {allPassed ? "yes" : "no"}</span>
        </section>
        {catalogError && <p style={{ color: "#fca5a5" }}>{catalogError}. This page requires an authenticated internal session.</p>}
        {sampleError && <p style={{ color: "#fca5a5" }}>{sampleError}</p>}
        {REVIEW_PERSONAS.map((persona) => {
          const metadata = catalog[persona];
          const isConfigured = Boolean(metadata?.voice_id && metadata.voice_id !== "REQUIRED");
          return <section key={persona} style={{ padding: 18, border: "1px solid #334155", borderRadius: 12, marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div><h2 style={{ margin: 0 }}>{persona}</h2><p style={{ color: "#94a3b8" }}>{metadata ? `${metadata.gender} · ${metadata.style} · ${metadata.tts_provider}` : "Catalog not loaded"}</p><p>Voice mapping: <strong style={{ color: isConfigured ? "#86efac" : "#fca5a5" }}>{isConfigured ? "configured" : "REQUIRED"}</strong></p></div>
              <button type="button" disabled={!isConfigured || loadingPersona !== null} onClick={() => void loadPersonaSamples(persona)}>{loadingPersona === persona ? "Loading samples…" : "Fetch cue samples"}</button>
            </div>
            <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th align="left">Cue</th><th align="left">Audio</th><th align="left">Duration</th><th align="left">Cache / fallback</th><th align="left">Review</th><th align="left">Comments</th></tr></thead><tbody>{REVIEW_CUES.map((cue) => {
              const key = `${persona}:${cue}`;
              const sample = samples[key];
              const review = reviews[key] ?? { status: "unreviewed" as ReviewStatus, comments: "" };
              return <tr key={key}>
                <td style={{ padding: "10px 6px" }}>{cue}</td>
                <td style={{ padding: "10px 6px" }}>{sample ? <button type="button" disabled={!sample.pcm} onClick={() => void playSample(sample)}>Play</button> : "—"}</td>
                <td style={{ padding: "10px 6px" }}>{sample ? `${sample.response.durationMs} ms` : "—"}</td>
                <td style={{ padding: "10px 6px" }}>{sample ? `${sample.response.cached ? "cached" : "fresh"} · ${sample.response.fallback ?? "none"}` : "—"}</td>
                <td style={{ padding: "10px 6px" }}><select value={review.status} onChange={(event) => updateReview(key, { status: event.target.value as ReviewStatus })}><option value="unreviewed">unreviewed</option><option value="pass">pass</option><option value="fail">fail</option><option value="unsure">unsure</option></select></td>
                <td style={{ padding: "10px 6px" }}><input value={review.comments} onChange={(event) => updateReview(key, { comments: event.target.value })} placeholder="tone, clarity, artifacts…" /></td>
              </tr>;
            })}</tbody></table></div>
          </section>;
        })}
        <p style={{ color: "#64748b" }}>No production rollout is performed from this page. Review artifacts should be saved under <code>artifacts/voice-persona-review/</code>.</p>
      </div>
    </main>
  );
}

function decodePcm16(value: string): Int16Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(bytes.buffer);
  const samples = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true);
  return samples;
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
