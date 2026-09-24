/**
 * The call's scrollback, plus the line being spoken right now.
 *
 * Two different things share this panel, and keeping them separate is the whole
 * point. A caption is transient: it shows the sentence in progress and is
 * replaced by the next one. History is permanent: finished turns, oldest first,
 * that the caller can scroll back through.
 *
 * Before this, the caption box was handed the growing session transcript, so
 * every sentence the caller had ever said stayed on screen underneath MindPal's
 * newer reply - one wall of text with no indication of who said what or when.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVoiceStore, type VoiceTurn } from '../../store/voice.ts';
import { wordBoundary } from '../../voice/call/speechTimeline.ts';

/** How far the scrollback fades into the edge it is cut off at. */
const EDGE_FADE_PX = 28;

/**
 * Fade only the edges that hide something: the top once earlier turns have
 * scrolled away, the bottom while newer ones sit below the fold. A permanent
 * fade would dim the first line of a short transcript for no reason.
 */
function edgeMask(top: boolean, bottom: boolean): string | undefined {
  if (!top && !bottom) return undefined;
  const start = top ? `transparent 0, #000 ${EDGE_FADE_PX}px` : '#000 0';
  const end = bottom ? `#000 calc(100% - ${EDGE_FADE_PX}px), transparent 100%` : '#000 100%';
  return `linear-gradient(to bottom, ${start}, ${end})`;
}

interface VoiceTranscriptProps {
  turns: VoiceTurn[];
  /** The sentence in progress. Empty between utterances. */
  live: string;
  /** Who is speaking the live line. */
  liveRole: 'user' | 'model';
  /**
   * MindPal has the turn but has not made a sound yet.
   *
   * The gap between the caller finishing and the first word of the reply is
   * usually one to three seconds, and with nothing on screen it reads as a dead
   * call - which is exactly what callers kept reporting.
   */
  thinking?: boolean;
  /** True while MindPal audio is actively playing through speakers. */
  isModelSpeaking?: boolean;
}

export function VoiceTranscript({ turns, live, liveRole, thinking = false, isModelSpeaking = false }: VoiceTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToEnd = useRef(true);
  const [copied, setCopied] = useState(false);
  const [fade, setFade] = useState({ top: false, bottom: false });
  // Subscribed here, not in the overlay: it changes ~12 times a second while
  // MindPal talks, and only this panel needs to re-render for it.
  const spokenChars = useVoiceStore((state) => state.aiSpokenChars);

  const syncFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
    setFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // Scrolling up is a deliberate act: the caller is reading something earlier.
  // Yanking them back to the bottom on the next word would make that impossible.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    syncFade();
  };

  const showThinking = thinking && !live.trim();

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedToEnd.current) el.scrollTop = el.scrollHeight;
    syncFade();
  }, [turns, live, showThinking, syncFade]);

  useEffect(() => {
    // A new call resets the reading position along with the content.
    if (turns.length === 0) pinnedToEnd.current = true;
  }, [turns.length]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyTranscript = async () => {
    const text = turns
      .map((turn) => `${turn.role === 'user' ? 'You' : 'MindPal'}: ${turn.text}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard refused (permissions or an insecure page); nothing to do */
    }
  };

  const empty = turns.length === 0 && !live.trim() && !showThinking;
  const liveIsModel = Boolean(live.trim()) && liveRole === 'model';
  const mask = edgeMask(fade.top, fade.bottom);

  return (
    <div className="w-full max-w-lg flex flex-col">
      {turns.length > 0 ? (
        <div className="flex justify-end px-2">
          <button
            type="button"
            onClick={() => void copyTranscript()}
            className="text-[11px] text-content-muted hover:text-content-secondary transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded"
            aria-label="Copy call transcript"
          >
            {copied ? 'Copied' : 'Copy transcript'}
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="w-full max-h-48 overflow-y-auto overscroll-contain px-2 py-2 flex flex-col gap-2 text-start"
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        aria-live="polite"
        aria-atomic="false"
        aria-label="Call transcript"
      >
        {empty ? (
          <p className="text-sm text-content-muted text-center py-3">
            Captions appear when you or MindPal speak.
          </p>
        ) : null}

        {turns.map((turn, idx) => {
          // The reply is committed to history when generation ends, which is
          // usually seconds before its audio does: keep tracking it until then.
          const playing =
            isModelSpeaking && !liveIsModel && turn.role === 'model' && idx === turns.length - 1;
          return (
            <Bubble
              key={turn.id}
              role={turn.role}
              text={turn.text}
              spokenChars={playing ? spokenChars : null}
            />
          );
        })}

        {live.trim() ? (
          <Bubble
            role={liveRole}
            text={live}
            live
            spokenChars={liveIsModel && isModelSpeaking ? spokenChars : null}
          />
        ) : null}

        {showThinking ? <ThinkingBubble /> : null}
      </div>
    </div>
  );
}

/**
 * One turn. While MindPal is speaking it, the words already heard are shown at
 * full strength and the rest faintly, so the caption reads along with the voice
 * instead of racing ahead of it. That split is the "speaking" indicator: no
 * outline, no equalizer bars.
 */
function Bubble({
  role,
  text,
  live = false,
  spokenChars = null,
}: {
  role: 'user' | 'model';
  text: string;
  live?: boolean;
  /** Characters heard so far, or null when this turn is not playing. */
  spokenChars?: number | null;
}) {
  const mine = role === 'user';
  const tracking = !mine && spokenChars !== null;
  const cut = tracking ? wordBoundary(text, spokenChars) : text.length;
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        // `dir="auto"` so an Arabic turn lays itself out right-to-left and an
        // English one does not. The two are mixed constantly in a real call.
        dir="auto"
        className={[
          'max-w-[85%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed break-words text-start',
          'transition-colors duration-300 ease-out',
          mine
            ? 'bg-brand-primary/10 text-content-primary rounded-br-md'
            : tracking
              ? 'bg-surface-elevated text-content-primary rounded-bl-md'
              : 'bg-surface-sunken text-content-secondary rounded-bl-md',
          live && !tracking ? 'opacity-85' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={tracking ? 'MindPal is speaking' : undefined}
      >
        {tracking ? (
          <>
            <span>{text.slice(0, cut)}</span>
            <span className="text-content-muted opacity-60">{text.slice(cut)}</span>
          </>
        ) : (
          <span>{text}</span>
        )}
      </div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start" role="status" aria-label="MindPal is thinking">
      <div className="px-3.5 py-3 rounded-2xl rounded-bl-md bg-surface-sunken flex items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="w-1.5 h-1.5 rounded-full bg-content-muted animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: `${dot * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
