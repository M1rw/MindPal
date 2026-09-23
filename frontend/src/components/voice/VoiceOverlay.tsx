import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Captions, Mic, MicOff, PhoneOff } from 'lucide-react';
import {
  useAuthStore,
  useChatHistoryStore,
  useChatStore,
  useFlagsStore,
  useSessionStore,
  useToastStore,
  useVoiceStore,
} from '../../store';
import { useFocusTrap } from '../../hooks/ui/useFocusTrap';
import { liveVoiceCaption } from '../../voice/session/caption.ts';
import { VoiceTranscript } from './VoiceTranscript.tsx';
import { LiveVoiceSession, type LiveCallReceipt } from '../../voice/call/callController.ts';
import { redactTraceReport, type VoiceTraceReport } from '../../voice/diagnostics/trace.ts';
import { ApiError } from '../../services/api/http.ts';
import { classifyVoiceError, voiceApi } from '../../services/api/voice.ts';
import { teardownActiveSession } from '../../voice/control/controlPlane.ts';
import { threadContinuation } from '../../utils/chat/sessionHistory.ts';
import { captureMemoryReceipt } from '../../utils/memory/guestMemory.ts';
import type { ChatMessage } from '../../types';
import {
  canOperateMute,
  CRISIS_DISCLAIMER,
  CRISIS_HANDOFF_LABEL,
  CRISIS_HANDOFF_TOAST,
  CRISIS_HEADING,
  CRISIS_RESOURCES,
  crisisPauseBody as resolveCrisisPauseBody,
  isCrisisSurface,
  STAY_SUPPORT_HINT,
} from '../../voice/safety/crisisUx.ts';
import { LOCAL_CRISIS_SCRIPT, STAY_HANDOFF_SCRIPT } from '../../voice/safety/crisisEnforcer.ts';
import type { LiveUiStatus } from '../../voice/types.ts';
import { presenceBus } from '../../voice/presenceBus.ts';
import { LivePresence } from './LivePresence.tsx';

const STATUS_LABEL: Record<LiveUiStatus, string> = {
  consent: 'Consent needed',
  connecting: 'Connecting',
  listening: 'Listening',
  speaking: 'Speaking',
  holding: 'Holding',
  unavailable: 'Unavailable',
  error: 'Couldn’t connect',
  stay_support: 'Still with you',
  crisis_freeze: 'Paused for safety',
};

function isStuckActiveSessionError(error: unknown): boolean {
  if (error instanceof ApiError && error.code === 'conflict') return true;
  const message = error instanceof Error ? error.message : String(error || '');
  return /already in progress on this account/i.test(message);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return reduced;
}

export const VoiceOverlay: React.FC = () => {
  const liveEnabled = useFlagsStore((state) => state.flags.voice_enabled);
  const isAuthenticated = useSessionStore((state) => state.isAuthenticated);
  // Field-level selectors. A bare `useVoiceStore()` re-rendered this whole tree
  // on every store write; the high-rate signals now bypass the store entirely
  // (see presenceBus), and what is left is subscribed to individually so a
  // caption update does not re-render the crisis panel.
  const isActive = useVoiceStore((state) => state.isActive);
  const isMuted = useVoiceStore((state) => state.isMuted);
  const uiStatus = useVoiceStore((state) => state.uiStatus);
  const statusDetail = useVoiceStore((state) => state.statusDetail);
  const transcript = useVoiceStore((state) => state.transcript);
  const turns = useVoiceStore((state) => state.turns);
  const thinking = useVoiceStore((state) => state.thinking);
  const aiTranscript = useVoiceStore((state) => state.aiTranscript);
  const crisisScript = useVoiceStore((state) => state.crisisScript);
  const crisisPauseBody = useVoiceStore((state) => state.crisisPauseBody);
  const voiceId = useVoiceStore((state) => state.voiceId);
  const floor = useVoiceStore((state) => state.floor);
  const expression = useVoiceStore((state) => state.expression);
  const commands = useVoiceStore((state) => state.commands);
  const sessionLimitS = useVoiceStore((state) => state.sessionLimitS);
  const quotaRemainingS = useVoiceStore((state) => state.quotaRemainingS);
  // Actions are stable identities on a zustand store; read them once.
  const {
    resetVoice,
    setIsMuted,
    setUiStatus,
    setVoiceId,
    setFloor,
    setTranscript,
    setAiTranscript,
    addTurn,
    setThinking,
    setCrisisScript,
    setExpression,
    setCommands,
    setQuota,
    clearCrisis,
  } = useVoiceStore.getState();
  const { push: pushToast } = useToastStore();
  const openAuthModal = useAuthStore((state) => state.openAuthModal);
  const addChatMessage = useChatStore((state) => state.addMessage);
  const boundChatSessionIdRef = useRef<string | null>(null);

  const fallbackRecap = (receipt: LiveCallReceipt): ChatMessage => ({
    id: `voice-${receipt.sessionId}`,
    role: 'assistant',
    kind: 'voice_receipt',
    content: receipt.crisis
      ? 'No recap was written for this call.'
      : 'A recap of what was said could not be written.\n\nThis is a recap of what was said on the call, not a clinical note.',
    timestamp: new Date().toISOString(),
    voice_used_s: receipt.usedS,
  });

  const persistLiveRecap = async (receipt: LiveCallReceipt) => {
    const chatSessionId =
      boundChatSessionIdRef.current || useChatHistoryStore.getState().ensureActiveSessionId();
    const placeholder = fallbackRecap(receipt);
    addChatMessage(placeholder);
    if (receipt.crisis || !receipt.sessionId) return;
    try {
      const result = await voiceApi.summarizeVoiceSession({
        session_id: receipt.sessionId,
        chat_session_id: chatSessionId,
        user_transcript: receipt.inputTranscript,
        ai_transcript: receipt.outputTranscript,
      });
      if (result.memory) {
        captureMemoryReceipt(result.memory, useSessionStore.getState().isAuthenticated);
      }
      if (result.message?.content) {
        const used = result.message.voice_used_s;
        const { messages, setMessages } = useChatStore.getState();
        setMessages(
          messages.map((message) =>
            message.id === placeholder.id
              ? {
                  ...message,
                  content: result.message!.content!,
                  ...(typeof used === 'number' && Number.isFinite(used) ? { voice_used_s: used } : {}),
                }
              : message
          )
        );
      }
    } catch {
      // Recap is best-effort. The call already ended; the divider stays honest.
    }
  };
  const [showCaptions, setShowCaptions] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const sessionRef = useRef<LiveVoiceSession | null>(null);
  const lastTraceRef = useRef<VoiceTraceReport | null>(null);
  const startingRef = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  /**
   * Crisis resources outlive the overlay. They are written into the text
   * conversation, which is persisted, before any voice state is cleared.
   */
  const handOffCrisisResources = () => {
    useChatHistoryStore.getState().ensureActiveSessionId();
    const status = useVoiceStore.getState().uiStatus;
    const script =
      useVoiceStore.getState().crisisScript ||
      (status === 'stay_support' ? STAY_HANDOFF_SCRIPT : LOCAL_CRISIS_SCRIPT);
    addChatMessage({
      id: `crisis-${Date.now()}`,
      role: 'assistant',
      content: script,
      timestamp: new Date().toISOString(),
    });
    clearCrisis();
    pushToast(CRISIS_HANDOFF_TOAST, 'warning');
  };

  const endSession = (reason = 'client_hangup') => {
    void sessionRef.current?.hangup(reason);
    sessionRef.current = null;
    setHasSession(false);
  };

  const close = () => {
    if (isCrisisSurface(useVoiceStore.getState().uiStatus, useVoiceStore.getState().crisisScript)) {
      handOffCrisisResources();
    }
    endSession();
    resetVoice();
  };

  const continueInText = () => {
    handOffCrisisResources();
    endSession();
    resetVoice();
  };

  const containerRef = useFocusTrap<HTMLDivElement>({
    isOpen: isActive && liveEnabled,
    onClose: close,
  });

  useEffect(() => {
    return () => {
      void sessionRef.current?.hangup('unmount');
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (liveEnabled && isActive) return;
    if (!sessionRef.current) return;
    void sessionRef.current.hangup(liveEnabled ? 'overlay_inactive' : 'flag_off');
    sessionRef.current = null;
    setHasSession(false);
  }, [liveEnabled, isActive]);

  useEffect(() => {
    sessionRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    if (liveEnabled && isActive && isAuthenticated) {
      if (!sessionRef.current && !startingRef.current && (uiStatus === 'consent' || uiStatus === 'connecting')) {
        void startCall();
      }
    }
  }, [liveEnabled, isActive, isAuthenticated, uiStatus]);

  const startCall = async (opts?: { recovered?: boolean }) => {
    if (!isAuthenticated) {
      setUiStatus('unavailable', 'Sign in to start a live voice call. Dictation still works without an account.');
      return;
    }
    if (startingRef.current || sessionRef.current) return;
    startingRef.current = true;
    const session = new LiveVoiceSession({
      onStatus: (status, detail) => setUiStatus(status, detail),
      onEnergy: (userEnergy) => presenceBus.publish({ userEnergy }),
      onPlaybackEnergy: (playbackEnergy, playbackBrightness) =>
        presenceBus.publish({
          playbackEnergy,
          ...(typeof playbackBrightness === 'number' ? { playbackBrightness } : {}),
        }),
      onVoiceId: setVoiceId,
      onQuota: setQuota,
      onFloor: setFloor,
      onInputCaption: setTranscript,
      onOutputCaption: setAiTranscript,
      onTurn: addTurn,
      onThinking: setThinking,
      onCrisis: (script, pauseBody) => {
        setCrisisScript(script || LOCAL_CRISIS_SCRIPT, pauseBody);
      },
      onMuted: setIsMuted,
      onFallback: (message) => {
        // The session already tore itself down; the controls must stop implying otherwise.
        sessionRef.current = null;
        setHasSession(false);
        pushToast(message, 'error');
      },
      onTrace: (report) => {
        lastTraceRef.current = report;
        console.info('[mindpal.voice] trace', report.findings.summary, report.findings.notes);
        if (report.sessionId && useSessionStore.getState().isAuthenticated) {
          void voiceApi.submitDiagnostics(report.sessionId, redactTraceReport(report)).catch(() => null);
        }
      },
      onEnded: (receipt) => {
        void persistLiveRecap(receipt);
      },
      onExpression: setExpression,
      onCommands: setCommands,
      onAffect: (affect) => presenceBus.publish({ affect }),
      onProsody: (prosody) => presenceBus.publish({ prosody }),
      onBackchannel: (backchannel, engagementBoost) =>
        presenceBus.publish({ backchannel, engagementBoost }),
      onReaction: (reaction) => presenceBus.publish({ reaction }),
      onDistress: (distress) => presenceBus.publish({ distress }),
    });
    sessionRef.current = session;
    boundChatSessionIdRef.current = useChatHistoryStore.getState().ensureActiveSessionId();
    session.setThreadNote(threadContinuation(useChatStore.getState().messages));
    const history = useChatHistoryStore.getState().sessions;
    session.setOpenerProfile({
      displayName: useAuthStore.getState().user?.displayName ?? null,
      // Newest first, and not the chat this call belongs to - that one is
      // already in the thread note.
      recentTopics: history
        .filter((item) => item.id !== boundChatSessionIdRef.current)
        .map((item) => item.title),
      returning: history.length > 1,
    });
    setHasSession(true);
    session.setMuted(isMuted);
    session.setReducedMotion(reducedMotion);
    try {
      await session.start();
    } catch (error) {
      sessionRef.current = null;
      setHasSession(false);
      void session.hangup('start_failed');
      // Old servers (or a race before reclaim) can still return conflict once.
      // Tear down the account active row and remint once before surfacing the error.
      if (!opts?.recovered && isStuckActiveSessionError(error)) {
        startingRef.current = false;
        clearCrisis();
        await teardownActiveSession('client_recover');
        await startCall({ recovered: true });
        return;
      }
      const classified = classifyVoiceError(error);
      setUiStatus(classified.kind === 'quota' || classified.kind === 'unavailable' ? 'unavailable' : 'error', classified.message);
      pushToast(classified.message, classified.kind === 'quota' ? 'warning' : 'error');
    } finally {
      startingRef.current = false;
    }
  };

  /** Clear a stuck server-side active row, then mint again (same-user reclaim also runs on mint). */
  const recoverAndStart = async () => {
    endSession('client_recover');
    await teardownActiveSession('client_recover');
    clearCrisis();
    await startCall({ recovered: true });
  };

  if (!liveEnabled || !isActive) return null;

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    sessionRef.current?.setMuted(next);
  };

  const ready =
    uiStatus === 'listening' ||
    uiStatus === 'speaking' ||
    uiStatus === 'holding' ||
    uiStatus === 'stay_support';
  const caption = liveVoiceCaption({ uiStatus, transcript, aiTranscript, crisisScript });
  const statusDot =
    uiStatus === 'listening' || uiStatus === 'stay_support'
      ? 'bg-feedback-success animate-pulse'
      : uiStatus === 'speaking'
        ? 'bg-brand-primary animate-bounce'
        : uiStatus === 'holding'
          ? 'bg-brand-primary/70'
          : uiStatus === 'unavailable' || uiStatus === 'error' || uiStatus === 'crisis_freeze'
            ? 'bg-feedback-danger'
            : 'bg-feedback-warning animate-ping';

  return (
    <div
      ref={containerRef}
      id="voice-live-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="voice-live-title"
      className="fixed inset-0 z-[100] flex flex-col justify-between overflow-hidden font-sans bg-surface-canvas text-content-primary"
    >
      <header className="relative z-20 flex items-center justify-between px-5 pt-safe-top pb-2 w-full">
        <button
          type="button"
          onClick={close}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-elevated text-content-secondary hover:text-content-primary transition-all duration-200 ease-out hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer"
          title="Close live voice"
          aria-label="Close live voice"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div id="voice-live-title" className="text-[15px] font-medium tracking-tight">
          Live voice
        </div>
        <button
          type="button"
          onClick={() => setShowCaptions((current) => !current)}
          className="min-w-10 h-10 px-2 flex items-center justify-center gap-1 rounded-full hover:bg-surface-elevated text-content-secondary hover:text-content-primary transition-all duration-200 ease-out hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer"
          aria-pressed={showCaptions}
          aria-label="Toggle captions"
        >
          <Captions className="w-5 h-5" />
          <span className="text-2xs font-bold">CC</span>
        </button>
      </header>

      <div className="relative z-20 flex justify-center px-5 py-2">
        <div
          role="status"
          aria-live="polite"
          className="px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide bg-surface-sunken text-content-secondary flex items-center gap-2"
        >
          <span className={`w-2 h-2 rounded-full ${statusDot}`} aria-hidden="true" />
          <span>{STATUS_LABEL[uiStatus]}</span>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center max-w-2xl mx-auto px-6 text-center relative z-20 space-y-4">
        {uiStatus !== 'unavailable' && uiStatus !== 'error' ? (
          <LivePresence
            voiceId={voiceId}
            floor={floor}
            userTranscript={transcript}
            modelTranscript={aiTranscript}
            command={expression}
            commands={commands}
            reducedMotion={reducedMotion || uiStatus === 'crisis_freeze'}
          />
        ) : null}

        {uiStatus === 'stay_support' ? (
          <div className="w-full max-w-md space-y-2">
            <ul className="flex flex-wrap items-center justify-center gap-2">
              {CRISIS_RESOURCES.map((resource) => (
                <li key={resource.id}>
                  <a
                    href={resource.href}
                    className="inline-flex px-2.5 py-1 rounded-full text-2xs font-semibold bg-surface-sunken text-content-secondary hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                  >
                    {resource.label}
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-xs text-content-muted leading-relaxed">{STAY_SUPPORT_HINT}</p>
            <button
              type="button"
              onClick={continueInText}
              className="text-xs font-semibold text-brand-primary hover:underline focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
            >
              {CRISIS_HANDOFF_LABEL}
            </button>
          </div>
        ) : null}

        {uiStatus === 'consent' ? (
          <div className="space-y-4 max-w-md">
            {!isAuthenticated ? (
              <>
                <p className="text-sm text-content-secondary leading-relaxed">
                  Sign in to start a live voice call. Guests can still dictate into the composer.
                  This is not a crisis line.
                </p>
                <button
                  type="button"
                  onClick={() => openAuthModal()}
                  className="px-5 py-2.5 rounded-xl bg-brand-primary hover:bg-brand-hover text-white text-sm font-semibold shadow-sm hover:shadow-md hover:shadow-brand-primary/25 hover:-translate-y-0.5 active:translate-y-0 active:scale-95 transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer"
                >
                  Sign in to start live voice
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {uiStatus === 'connecting' ? (
          <p className="text-sm text-content-secondary">
            {statusDetail || 'Connecting to live voice… this is not listening yet.'}
          </p>
        ) : null}

        {ready && sessionLimitS > 0 ? (
          <p className="text-xs text-content-muted">
            This call is reserved for {Math.round(sessionLimitS / 60)} minutes
            {quotaRemainingS > 0
              ? `. About ${Math.max(1, Math.round(quotaRemainingS / 60))} minutes left today after this reserve.`
              : '. Today’s remaining live minutes are in this call.'}
          </p>
        ) : null}

        {uiStatus === 'unavailable' || uiStatus === 'error' ? (
          <div className="space-y-4 max-w-md">
            <p className="text-sm text-content-secondary leading-relaxed">
              {statusDetail || 'Live voice is unavailable. Use composer dictation or text chat.'}
            </p>
            {!isAuthenticated ? (
              <button
                type="button"
                onClick={() => openAuthModal()}
                className="px-5 py-2.5 rounded-xl bg-brand-primary hover:bg-brand-hover text-white text-sm font-semibold shadow-sm hover:shadow-md hover:shadow-brand-primary/25 hover:-translate-y-0.5 active:translate-y-0 active:scale-95 transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer"
              >
                Sign in to start live voice
              </button>
            ) : (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => void recoverAndStart()}
                  className="px-5 py-2.5 rounded-xl bg-brand-primary hover:bg-brand-hover text-white text-sm font-semibold shadow-sm hover:shadow-md hover:shadow-brand-primary/25 hover:-translate-y-0.5 active:translate-y-0 active:scale-95 transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer"
                >
                  {isStuckActiveSessionError(statusDetail)
                    ? 'End previous call and retry'
                    : 'Try again'}
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="px-5 py-2.5 rounded-xl bg-surface-sunken text-content-secondary hover:text-content-primary hover:bg-surface-elevated text-sm font-medium hover:-translate-y-0.5 active:translate-y-0 active:scale-95 transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer"
                >
                  End
                </button>
              </div>
            )}
          </div>
        ) : null}

        {uiStatus === 'crisis_freeze' ? (
          <section
            role="alert"
            aria-labelledby="voice-crisis-heading"
            className="w-full max-w-md space-y-3 p-4 rounded-2xl bg-surface-card border border-feedback-danger/40 text-left"
          >
            <h2 id="voice-crisis-heading" className="text-[15px] font-semibold text-content-primary">
              {CRISIS_HEADING}
            </h2>
            <p className="text-sm text-content-secondary leading-relaxed">
              {resolveCrisisPauseBody(undefined, crisisPauseBody)}
            </p>
            <p className="text-sm text-content-secondary leading-relaxed">
              Your microphone is off. The call released it when it paused.
            </p>
            <ul className="space-y-2">
              {CRISIS_RESOURCES.map((resource) => (
                <li key={resource.id}>
                  <a
                    href={resource.href}
                    className="flex flex-col px-3 py-2.5 rounded-xl bg-feedback-danger/10 text-feedback-danger hover:bg-feedback-danger/20 transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
                  >
                    <span className="text-sm font-semibold">{resource.label}</span>
                    <span className="text-xs text-content-secondary">{resource.detail}</span>
                  </a>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={continueInText}
              className="w-full px-4 py-2.5 rounded-xl bg-brand-primary hover:bg-brand-hover text-white text-sm font-medium focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
            >
              {CRISIS_HANDOFF_LABEL}
            </button>
            <p className="text-xs text-content-muted leading-relaxed">{CRISIS_DISCLAIMER}</p>
          </section>
        ) : null}

        {showCaptions && ready ? (
          crisisScript ? (
            // A crisis script is read verbatim and must not be scrolled away
            // from or interleaved with conversation bubbles.
            <div
              className="max-h-36 overflow-y-auto px-4 py-3 rounded-2xl bg-surface-sunken text-sm text-content-secondary leading-relaxed max-w-lg min-h-[3rem]"
              aria-live="assertive"
            >
              <p>{caption}</p>
            </div>
          ) : (
            <VoiceTranscript
              turns={turns}
              live={uiStatus === 'speaking' ? aiTranscript : transcript}
              liveRole={uiStatus === 'speaking' ? 'model' : 'user'}
              thinking={thinking && uiStatus !== 'speaking'}
              isModelSpeaking={uiStatus === 'speaking'}
            />
          )
        ) : null}
      </div>

      <div className="relative z-20 w-full max-w-md mx-auto px-6 flex flex-col items-center pb-safe pb-8">
        <div className="flex items-center gap-3 p-1.5 rounded-2xl bg-surface-card border border-edge-subtle shadow-sm">
          <button
            type="button"
            onClick={close}
            className="h-11 px-5 flex items-center gap-2 rounded-xl bg-feedback-danger/10 text-feedback-danger text-[13px] font-semibold hover:bg-feedback-danger/25 hover:text-feedback-danger hover:shadow-md hover:shadow-feedback-danger/20 hover:-translate-y-0.5 active:translate-y-0 active:scale-95 transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer"
            aria-label="End live voice"
          >
            <PhoneOff className="w-4 h-4" />
            <span>End</span>
          </button>
          <button
            type="button"
            onClick={toggleMute}
            disabled={!canOperateMute(uiStatus, hasSession)}
            className={`h-11 px-5 flex items-center gap-2 rounded-xl text-[13px] font-semibold transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none ${
              isMuted
                ? 'bg-feedback-warning/15 text-feedback-warning border border-feedback-warning/30 hover:bg-feedback-warning/25 hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 active:scale-95'
                : 'bg-surface-sunken text-content-secondary hover:bg-surface-elevated hover:text-content-primary hover:shadow-sm hover:-translate-y-0.5 active:translate-y-0 active:scale-95'
            }`}
            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>{isMuted ? 'Muted' : 'Mute'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
