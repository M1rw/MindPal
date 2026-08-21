import { useEffect, useMemo, useState } from "react";
import type { LayerLinkEnvelope, VoiceRuntimeSnapshot } from "../core/layer-link";
import { LayerLinkMessageBus, type BusSnapshot } from "../core/message-bus";
import type { CaptureManager, CaptureMetrics } from "../layers/capture/capture-manager";
import type { TransportSnapshot } from "../layers/transport/ws-manager";
import type { PlaybackSnapshot } from "../layers/playback/playback-manager";
import type { ConductorSnapshot } from "../layers/backchannel/conductor";
import type { OrchestratorSnapshot } from "../layers/orchestrator/orchestrator";
import type { CaptionPacerSnapshot } from "../layers/caption/pacer";
import type { VoiceProviderMode, VoiceV3App } from "../app";
import type { ProsodySnapshot } from "../layers/prosody/prosody-state";
import type { LocalMemoryRecord } from "../layers/memory/local-memory-store";

export type DebugPanelProps = {
  readonly bus: LayerLinkMessageBus;
  readonly captureManager?: CaptureManager;
  readonly app?: VoiceV3App;
  readonly providerMode?: VoiceProviderMode;
  readonly onToggleProvider?: () => void;
  readonly initialSnapshot?: VoiceRuntimeSnapshot;
};

type TelemetryEntry = {
  readonly id: string;
  readonly timestamp: string;
  readonly messageType: string;
  readonly sourceLayer: string;
};

const EMPTY_RUNTIME_SNAPSHOT: VoiceRuntimeSnapshot = {
  state: "idle",
  identity: {
    sessionGeneration: "none",
    turnId: null,
    providerResponseId: null,
    playbackGeneration: null,
  },
  queueSnapshots: [],
  staleEventsRejected: 0,
  telemetryDropped: 0,
  updatedAtMono: 0,
};

const EMPTY_CAPTURE_METRICS: CaptureMetrics = {
  rms: 0,
  muted: false,
  sampleRate: 0,
  framesEmitted: 0,
  lastSequence: null,
};

const EMPTY_TRANSPORT_SNAPSHOT: TransportSnapshot = {
  state: "IDLE",
  ready: false,
  queueDepth: 0,
  queueCapacity: 50,
  framesSent: 0,
  framesDropped: 0,
  bytesSent: 0,
  resumptionHandle: null,
  lastSentAtMono: 0,
  setupSent: false,
};

type AdapterStats = {
  readonly lastEventType: string | null;
  readonly normalizedEvents: number;
  readonly thoughtsFiltered: number;
};

const EMPTY_PLAYBACK_SNAPSHOT: PlaybackSnapshot = {
  state: "IDLE",
  queueDepthMs: 0,
  activeGenerationId: null,
  mainGain: 1,
  backchannelGain: 0.4,
  scheduledSources: 0,
};

const EMPTY_CONDUCTOR_SNAPSHOT: ConductorSnapshot = {
  state: "IDLE",
  cooldownRemainingMs: 0,
  cuesTriggered: 0,
  cuesInRollingWindow: 0,
  lastSuppressionReason: null,
  continuousSpeechMs: 0,
  pauseMs: 0,
  mainLaneSpeaking: false,
  pendingCueBufferStatus: "empty",
  predictivePrefetchLatencyMs: null,
  ttsProviderState: "idle",
  lastCueSource: null,
};

const EMPTY_CAPTION_SNAPSHOT: CaptionPacerSnapshot = {
  activeAssemblerText: "",
  pendingQueueDepth: 0,
  lastReleasedCaption: null,
  driftEstimateMs: 0,
  closedTurns: 0,
  currentPlaybackGeneration: null,
};

type MemoryDebugSnapshot = {
  readonly record: LocalMemoryRecord;
  readonly injectedContext: string | null;
  readonly extractionCount: number;
};

const EMPTY_MEMORY_SNAPSHOT: MemoryDebugSnapshot = {
  record: { userId: "none", lastUpdated: 0, keyFacts: [], preferences: [] },
  injectedContext: null,
  extractionCount: 0,
};

const EMPTY_PROSODY_SNAPSHOT: ProsodySnapshot = {
  state: {
    energyLevel: "normal",
    speechRate: "normal",
    pausePattern: "continuous",
    emotionalGuess: "neutral",
    confidence: 0,
    lastChangedAtMono: 0,
  },
  noiseFloorRms: 0.0025,
  lastContextNote: null,
  lastContextReason: null,
  backchannelStyle: "standard",
  speechWindowMs: 0,
  transcriptRateWpm: 0,
  interruptionCount: 0,
};

const EMPTY_ORCHESTRATOR_SNAPSHOT: OrchestratorSnapshot = {
  state: "IDLE",
  identity: {
    sessionGeneration: "none",
    turnId: null,
    providerResponseId: null,
    playbackGeneration: null,
  },
  operationId: null,
  greetingSent: false,
  providerResponseClosed: false,
  staleEventsRejected: 0,
};

/**
 * Development-only overlay for LayerLink, Capture Layer, and Transport Layer
 * observability. It consumes immutable bus messages and never mutates engine
 * state directly.
 */
export function DebugPanel({
  bus,
  captureManager,
  app,
  providerMode = "mock",
  onToggleProvider,
  initialSnapshot,
}: DebugPanelProps) {
  const [runtimeSnapshot] = useState<VoiceRuntimeSnapshot>(
    initialSnapshot ?? EMPTY_RUNTIME_SNAPSHOT,
  );
  const [busSnapshot, setBusSnapshot] = useState<BusSnapshot>(() => bus.snapshot());
  const [captureMetrics, setCaptureMetrics] = useState<CaptureMetrics>(EMPTY_CAPTURE_METRICS);
  const [transportSnapshot, setTransportSnapshot] = useState<TransportSnapshot>(
    EMPTY_TRANSPORT_SNAPSHOT,
  );
  const [adapterStats, setAdapterStats] = useState<AdapterStats>({
    lastEventType: null,
    normalizedEvents: 0,
    thoughtsFiltered: 0,
  });
  const [playbackSnapshot, setPlaybackSnapshot] = useState<PlaybackSnapshot>(
    EMPTY_PLAYBACK_SNAPSHOT,
  );
  const [conductorSnapshot, setConductorSnapshot] = useState<ConductorSnapshot>(
    EMPTY_CONDUCTOR_SNAPSHOT,
  );
  const [orchestratorSnapshot, setOrchestratorSnapshot] = useState<OrchestratorSnapshot>(
    EMPTY_ORCHESTRATOR_SNAPSHOT,
  );
  const [captionSnapshot, setCaptionSnapshot] = useState<CaptionPacerSnapshot>(EMPTY_CAPTION_SNAPSHOT);
  const [prosodySnapshot, setProsodySnapshot] = useState<ProsodySnapshot>(EMPTY_PROSODY_SNAPSHOT);
  const [memorySnapshot, setMemorySnapshot] = useState<MemoryDebugSnapshot>(EMPTY_MEMORY_SNAPSHOT);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string>("No messages received");
  const [eventLog, setEventLog] = useState<readonly TelemetryEntry[]>([]);

  useEffect(() => {
    const unsubscribe = bus.subscribe<unknown>((envelope: LayerLinkEnvelope<unknown>) => {
      setBusSnapshot(bus.snapshot());
      setLastMessage(`${envelope.messageType} · ${envelope.sourceLayer}`);
      setEventLog((previous) => [
        ...previous,
        {
          id: envelope.messageId,
          timestamp: envelope.timestampWall,
          messageType: envelope.messageType,
          sourceLayer: envelope.sourceLayer,
        },
      ].slice(-20));
      if (envelope.messageType === "capture.metrics.updated") {
        const metrics = parseCaptureMetrics(envelope.payload);
        if (metrics) setCaptureMetrics(metrics);
      }
      if (envelope.messageType === "transport.snapshot.updated") {
        const snapshot = parseTransportSnapshot(envelope.payload);
        if (snapshot) setTransportSnapshot(snapshot);
      }
      if (envelope.messageType === "playback.snapshot.updated") {
        const snapshot = parsePlaybackSnapshot(envelope.payload);
        if (snapshot) setPlaybackSnapshot(snapshot);
      }
      if (envelope.messageType === "backchannel.snapshot.updated") {
        const snapshot = parseConductorSnapshot(envelope.payload);
        if (snapshot) setConductorSnapshot(snapshot);
      }
      if (envelope.messageType === "orchestrator.snapshot.updated") {
        const snapshot = parseOrchestratorSnapshot(envelope.payload);
        if (snapshot) setOrchestratorSnapshot(snapshot);
      }
      if (envelope.messageType === "caption.snapshot.updated") {
        const snapshot = parseCaptionSnapshot(envelope.payload);
        if (snapshot) setCaptionSnapshot(snapshot);
      }
      if (envelope.messageType === "prosody.snapshot.updated") {
        const snapshot = parseProsodySnapshot(envelope.payload);
        if (snapshot) setProsodySnapshot(snapshot);
      }
      if (envelope.messageType === "memory.snapshot.updated") {
        const snapshot = parseMemorySnapshot(envelope.payload);
        if (snapshot) setMemorySnapshot(snapshot);
      }
      if (
        envelope.sourceLayer === "provider-adapter" &&
        envelope.messageType.startsWith("PROVIDER_")
      ) {
        setAdapterStats((previous) => ({
          lastEventType: envelope.messageType,
          normalizedEvents: previous.normalizedEvents + 1,
          thoughtsFiltered:
            previous.thoughtsFiltered +
            (envelope.messageType === "PROVIDER_INTERNAL_THOUGHT_FILTERED" ? 1 : 0),
        }));
      }
    });
    return unsubscribe;
  }, [bus]);

  const queues = useMemo(
    () =>
      runtimeSnapshot.queueSnapshots.length > 0
        ? runtimeSnapshot.queueSnapshots
        : [
            {
              name: "LayerLink control",
              depth: 0,
              capacity: 0,
              highWatermark: 0,
              lowWatermark: 0,
            },
          ],
    [runtimeSnapshot.queueSnapshots],
  );

  const startCapture = async () => {
    if (!captureManager) return;
    setCaptureError(null);
    try {
      if (app) await app.start();
      else await captureManager.start();
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "Voice session failed to start");
    }
  };

  const stopCapture = async () => {
    if (!captureManager) return;
    try {
      if (app) await app.stop();
      else await captureManager.stop();
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "Voice session failed to stop");
    }
  };

  const toggleMute = () => {
    if (app) app.setMuted(!captureManager?.isMuted);
    else if (captureManager) captureManager.setMuted(!captureManager.isMuted);
  };

  return (
    <aside
      aria-label="MindPal Voice V3 debug panel"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1000,
        width: "min(400px, calc(100vw - 32px))",
        maxHeight: "min(760px, calc(100vh - 32px))",
        overflow: "auto",
        padding: 16,
        border: "1px solid rgba(148, 163, 184, .28)",
        borderRadius: 16,
        background: "rgba(11, 16, 32, .94)",
        color: "#e2e8f0",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        boxShadow: "0 20px 60px rgba(0, 0, 0, .35)",
        backdropFilter: "blur(16px)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <strong style={{ color: "#93c5fd" }}>VOICE V3 DEBUG</strong>
        <span style={{ color: "#86efac" }}>SPRINT 15</span>
      </div>

      <section style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={onToggleProvider} disabled={!onToggleProvider}>
          Provider: {providerMode === "mock" ? "Mock Provider" : "Real WebSocket"}
        </button>
        {app && providerMode === "mock" && (
          <>
            <button type="button" onClick={() => app.simulateUserSpeech()} disabled={app.transportManager.state !== "OPEN"}>
              Simulate speech
            </button>
            <button type="button" onClick={() => app.simulateInterruption()} disabled={app.transportManager.state !== "OPEN"}>
              Simulate interruption
            </button>
            <button type="button" onClick={() => app.simulateTurnComplete()} disabled={app.transportManager.state !== "OPEN"}>
              Simulate turn complete
            </button>
          </>
        )}
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 4 }}>ORCHESTRATOR</div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{orchestratorSnapshot.state}</div>
        <div style={{ color: "#cbd5e1", marginTop: 4 }}>
          session: {orchestratorSnapshot.identity.sessionGeneration}
        </div>
        <div style={{ color: "#cbd5e1", marginTop: 2 }}>
          turn: {orchestratorSnapshot.identity.turnId ?? "none"}
        </div>
        <div style={{ color: "#cbd5e1", marginTop: 2 }}>
          response: {orchestratorSnapshot.identity.providerResponseId ?? "none"}
        </div>
        <div style={{ color: "#cbd5e1", marginTop: 2 }}>
          playback: {orchestratorSnapshot.identity.playbackGeneration ?? "none"}
        </div>
        <div style={{ color: "#cbd5e1", marginTop: 2 }}>
          stale rejected: {orchestratorSnapshot.staleEventsRejected}
        </div>
        {orchestratorSnapshot.state === "FAILED" && (
          <div style={{ color: "#fca5a5", marginTop: 8 }}>
            Voice transport failed. Check the transport telemetry and restart the session.
          </div>
        )}
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>CAPTURE LAYER</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>RMS</span>
          <span>{captureMetrics.rms.toFixed(4)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>mute</span>
          <span style={{ color: captureMetrics.muted ? "#fca5a5" : "#86efac" }}>
            {captureMetrics.muted ? "ON" : "OFF"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>native → target</span>
          <span>{captureMetrics.sampleRate || "—"} → 16000 Hz</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>frames</span>
          <span>{captureMetrics.framesEmitted}</span>
        </div>
        <div
          aria-label="Microphone RMS level"
          style={{
            height: 8,
            marginTop: 8,
            overflow: "hidden",
            borderRadius: 999,
            background: "rgba(148, 163, 184, .18)",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, Math.round(captureMetrics.rms * 100 * 2))}%`,
              height: "100%",
              borderRadius: 999,
              background: captureMetrics.muted ? "#64748b" : "#60a5fa",
              transition: "width 80ms linear, background 120ms ease-out",
            }}
          />
        </div>
        {captureManager && (
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" onClick={startCapture} disabled={captureManager.isRunning}>
              Start mic
            </button>
            <button type="button" onClick={stopCapture} disabled={!captureManager.isRunning}>
              Stop mic
            </button>
            <button
              type="button"
              onClick={toggleMute}
              disabled={!captureManager.isRunning}
            >
              {captureMetrics.muted ? "Unmute" : "Mute"}
            </button>
          </div>
        )}
        {captureError && <div style={{ color: "#fca5a5", marginTop: 8 }}>{captureError}</div>}
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>TRANSPORT LAYER</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>WebSocket</span>
          <span style={{ color: transportSnapshot.state === "OPEN" ? "#86efac" : "#fbbf24" }}>
            {transportSnapshot.state}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>ready</span>
          <span>{transportSnapshot.ready ? "YES" : "NO"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>queue</span>
          <span>
            {transportSnapshot.queueDepth}/{transportSnapshot.queueCapacity}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>frames sent / dropped</span>
          <span>
            {transportSnapshot.framesSent} / {transportSnapshot.framesDropped}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>bytes sent</span>
          <span>{transportSnapshot.bytesSent.toLocaleString()}</span>
        </div>
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>PROVIDER ADAPTER</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>last event</span>
          <span>{adapterStats.lastEventType ?? "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>normalized events</span>
          <span>{adapterStats.normalizedEvents}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>thoughts filtered</span>
          <span>{adapterStats.thoughtsFiltered}</span>
        </div>
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>PLAYBACK LAYER</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>state</span>
          <span>{playbackSnapshot.state}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>queue depth</span>
          <span>{playbackSnapshot.queueDepthMs.toFixed(1)} ms</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>generation</span>
          <span>{playbackSnapshot.activeGenerationId ?? "—"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>main / backchannel gain</span>
          <span>
            {playbackSnapshot.mainGain.toFixed(2)} / {playbackSnapshot.backchannelGain.toFixed(2)}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>scheduled sources</span>
          <span>{playbackSnapshot.scheduledSources}</span>
        </div>
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>BACKCHANNEL CONDUCTOR</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>state</span>
          <span>{conductorSnapshot.state}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>cooldown</span>
          <span>{conductorSnapshot.cooldownRemainingMs.toFixed(0)} ms</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>cues triggered</span>
          <span>{conductorSnapshot.cuesTriggered}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>rolling window</span>
          <span>{conductorSnapshot.cuesInRollingWindow}/3</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>TTS provider</span>
          <span>{conductorSnapshot.ttsProviderState}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>pending cue</span>
          <span>{conductorSnapshot.pendingCueBufferStatus}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>prefetch latency</span>
          <span>{conductorSnapshot.predictivePrefetchLatencyMs === null ? "—" : `${conductorSnapshot.predictivePrefetchLatencyMs.toFixed(1)} ms`}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>suppression</span>
          <span>{conductorSnapshot.lastSuppressionReason ?? "—"}</span>
        </div>
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>PROSODY / EMOTION</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>energy</span><span>{prosodySnapshot.state.energyLevel}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>speech rate</span><span>{prosodySnapshot.state.speechRate} · {prosodySnapshot.transcriptRateWpm.toFixed(0)} WPM</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>pause pattern</span><span>{prosodySnapshot.state.pausePattern}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>emotional guess</span><span>{prosodySnapshot.state.emotionalGuess}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>confidence</span><span>{(prosodySnapshot.state.confidence * 100).toFixed(0)}%</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>backchannel style</span><span>{prosodySnapshot.backchannelStyle}</span></div>
        <div style={{ marginTop: 6, color: "#cbd5e1", wordBreak: "break-word" }}>context: {prosodySnapshot.lastContextNote ?? "—"}</div>
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>LOCAL VOICE MEMORY</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>facts</span><span>{memorySnapshot.record.keyFacts.length}/20</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>preferences</span><span>{memorySnapshot.record.preferences.length}/20</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>extracted this session</span><span>{memorySnapshot.extractionCount}</span></div>
        <div style={{ marginTop: 6, color: "#cbd5e1", wordBreak: "break-word" }}>key facts: {memorySnapshot.record.keyFacts.join(" · ") || "—"}</div>
        <div style={{ marginTop: 4, color: "#cbd5e1", wordBreak: "break-word" }}>preferences: {memorySnapshot.record.preferences.join(" · ") || "—"}</div>
        <div style={{ marginTop: 4, color: "#cbd5e1", wordBreak: "break-word" }}>injected: {memorySnapshot.injectedContext ?? "—"}</div>
        {app && <button type="button" onClick={() => void app.clearMemory()}>Clear memory</button>}
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>TRANSCRIPT / CAPTION</div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>assembler text</span>
          <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {captionSnapshot.activeAssemblerText || "—"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>pending captions</span>
          <span>{captionSnapshot.pendingQueueDepth}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>last released</span>
          <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {captionSnapshot.lastReleasedCaption ?? "—"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>drift estimate</span>
          <span>{captionSnapshot.driftEstimateMs.toFixed(1)} ms</span>
        </div>
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>TELEMETRY LOG · LAST 20</div>
        <div style={{ display: "grid", gap: 3, maxHeight: 180, overflow: "auto" }}>
          {eventLog.length === 0 && <span style={{ color: "#64748b" }}>No LayerLink events yet</span>}
          {eventLog.map((entry) => (
            <div
              key={entry.id}
              style={{
                display: "grid",
                gridTemplateColumns: "76px 1fr",
                gap: 6,
                color: layerColor(entry.sourceLayer),
              }}
            >
              <span>{entry.sourceLayer}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {entry.messageType}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 14 }}>
        <div style={{ color: "#94a3b8", marginBottom: 6 }}>QUEUES</div>
        {queues.map((queue) => (
          <div
            key={queue.name}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 8,
              padding: "5px 0",
              borderBottom: "1px solid rgba(148, 163, 184, .12)",
            }}
          >
            <span>{queue.name}</span>
            <span>
              {queue.depth}/{queue.capacity || "—"}
            </span>
          </div>
        ))}
      </section>

      <section style={{ marginTop: 14, display: "grid", gap: 4 }}>
        <div style={{ color: "#94a3b8" }}>BUS METRICS</div>
        <div>delivered: {busSnapshot.deliveredEvents}</div>
        <div>rejected: {busSnapshot.rejectedEvents}</div>
        <div>expired: {busSnapshot.expiredEvents}</div>
        <div>handler failures: {busSnapshot.handlerFailures}</div>
        <div>stale artifacts: {runtimeSnapshot.staleEventsRejected}</div>
        <div>telemetry dropped: {runtimeSnapshot.telemetryDropped}</div>
      </section>

      <div style={{ marginTop: 14, color: "#94a3b8", wordBreak: "break-word" }}>
        last: {lastMessage}
      </div>
    </aside>
  );
}

function parseOrchestratorSnapshot(value: unknown): OrchestratorSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<OrchestratorSnapshot>;
  const identity = candidate.identity;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.greetingSent !== "boolean" ||
    typeof candidate.providerResponseClosed !== "boolean" ||
    typeof candidate.staleEventsRejected !== "number" ||
    (candidate.operationId !== null && typeof candidate.operationId !== "string") ||
    typeof identity !== "object" ||
    identity === null ||
    typeof identity.sessionGeneration !== "string"
  ) {
    return null;
  }
  return candidate as OrchestratorSnapshot;
}

function parseMemorySnapshot(value: unknown): MemoryDebugSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly record?: unknown; readonly injectedContext?: unknown; readonly extractionCount?: unknown };
  if (typeof candidate.record !== "object" || candidate.record === null || typeof candidate.extractionCount !== "number") return null;
  const record = candidate.record as Partial<LocalMemoryRecord>;
  if (typeof record.userId !== "string" || typeof record.lastUpdated !== "number" || !Array.isArray(record.keyFacts) || !Array.isArray(record.preferences)) return null;
  return {
    record: {
      userId: record.userId,
      lastUpdated: record.lastUpdated,
      keyFacts: record.keyFacts.filter((item): item is string => typeof item === "string").slice(-20),
      preferences: record.preferences.filter((item): item is string => typeof item === "string").slice(-20),
    },
    injectedContext: typeof candidate.injectedContext === "string" ? candidate.injectedContext : null,
    extractionCount: Math.max(0, candidate.extractionCount),
  };
}

function layerColor(layer: string): string {
  switch (layer) {
    case "capture": return "#60a5fa";
    case "transport": return "#fbbf24";
    case "provider-adapter": return "#c084fc";
    case "orchestrator": return "#f472b6";
    case "playback": return "#34d399";
    case "transcript": return "#2dd4bf";
    case "caption": return "#a3e635";
    case "backchannel": return "#fb923c";
    case "prosody": return "#f59e0b";
    default: return "#cbd5e1";
  }
}

function parseCaptionSnapshot(value: unknown): CaptionPacerSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<CaptionPacerSnapshot>;
  if (
    typeof candidate.activeAssemblerText !== "string" ||
    typeof candidate.pendingQueueDepth !== "number" ||
    (candidate.lastReleasedCaption !== null && typeof candidate.lastReleasedCaption !== "string") ||
    typeof candidate.driftEstimateMs !== "number" ||
    typeof candidate.closedTurns !== "number" ||
    (candidate.currentPlaybackGeneration !== null && typeof candidate.currentPlaybackGeneration !== "string")
  ) return null;
  return candidate as CaptionPacerSnapshot;
}

function parseCaptureMetrics(value: unknown): CaptureMetrics | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<CaptureMetrics>;
  if (
    typeof candidate.rms !== "number" ||
    typeof candidate.muted !== "boolean" ||
    typeof candidate.sampleRate !== "number" ||
    typeof candidate.framesEmitted !== "number" ||
    (candidate.lastSequence !== null && typeof candidate.lastSequence !== "number")
  ) {
    return null;
  }
  return candidate as CaptureMetrics;
}

function parsePlaybackSnapshot(value: unknown): PlaybackSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<PlaybackSnapshot>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.queueDepthMs !== "number" ||
    (candidate.activeGenerationId !== null && typeof candidate.activeGenerationId !== "string") ||
    typeof candidate.mainGain !== "number" ||
    typeof candidate.backchannelGain !== "number" ||
    typeof candidate.scheduledSources !== "number"
  ) {
    return null;
  }
  return candidate as PlaybackSnapshot;
}

function parseConductorSnapshot(value: unknown): ConductorSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly snapshot?: Partial<ConductorSnapshot> } & Partial<ConductorSnapshot>;
  const snapshot = candidate.snapshot ?? candidate;
  if (
    typeof snapshot.state !== "string" ||
    typeof snapshot.cooldownRemainingMs !== "number" ||
    typeof snapshot.cuesTriggered !== "number" ||
    typeof snapshot.cuesInRollingWindow !== "number" ||
    (snapshot.lastSuppressionReason !== null && typeof snapshot.lastSuppressionReason !== "string") ||
    typeof snapshot.continuousSpeechMs !== "number" ||
    typeof snapshot.pauseMs !== "number" ||
    typeof snapshot.mainLaneSpeaking !== "boolean"
  ) {
    return null;
  }
  return snapshot as ConductorSnapshot;
}

function parseProsodySnapshot(value: unknown): ProsodySnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ProsodySnapshot>;
  const state = candidate.state;
  if (typeof state !== "object" || state === null || typeof state.energyLevel !== "string" || typeof state.speechRate !== "string" || typeof state.pausePattern !== "string" || typeof state.emotionalGuess !== "string" || typeof state.confidence !== "number" || typeof state.lastChangedAtMono !== "number" || typeof candidate.noiseFloorRms !== "number" || typeof candidate.backchannelStyle !== "string" || typeof candidate.speechWindowMs !== "number" || typeof candidate.transcriptRateWpm !== "number" || typeof candidate.interruptionCount !== "number") return null;
  if (candidate.lastContextNote !== null && typeof candidate.lastContextNote !== "string") return null;
  if (candidate.lastContextReason !== null && typeof candidate.lastContextReason !== "string") return null;
  return candidate as ProsodySnapshot;
}

function parseTransportSnapshot(value: unknown): TransportSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<TransportSnapshot>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.ready !== "boolean" ||
    typeof candidate.queueDepth !== "number" ||
    typeof candidate.queueCapacity !== "number" ||
    typeof candidate.framesSent !== "number" ||
    typeof candidate.framesDropped !== "number" ||
    typeof candidate.bytesSent !== "number" ||
    (candidate.resumptionHandle !== null && typeof candidate.resumptionHandle !== "string") ||
    typeof candidate.lastSentAtMono !== "number" ||
    typeof candidate.setupSent !== "boolean"
  ) {
    return null;
  }
  return candidate as TransportSnapshot;
}
