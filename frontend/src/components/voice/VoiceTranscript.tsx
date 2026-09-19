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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { VoiceTurn } from '../../store/voice.ts';

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

  // Scrolling up is a deliberate act: the caller is reading something earlier.
  // Yanking them back to the bottom on the next word would make that impossible.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  const showThinking = thinking && !live.trim();

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToEnd.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns, live, showThinking]);

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
        className="w-full max-h-48 overflow-y-auto px-2 py-2 flex flex-col gap-2"
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
          const isSpeaking = isModelSpeaking && turn.role === 'model' && idx === turns.length - 1;
          return (
            <Bubble
              key={turn.id}
              role={turn.role}
              text={turn.text}
              speaking={isSpeaking}
            />
          );
        })}

        {live.trim() ? <Bubble role={liveRole} text={live} live speaking={isModelSpeaking && liveRole === 'model'} /> : null}

        {showThinking ? <ThinkingBubble /> : null}
      </div>
    </div>
  );
}

function Bubble({
  role,
  text,
  live = false,
  speaking = false,
}: {
  role: 'user' | 'model';
  text: string;
  live?: boolean;
  speaking?: boolean;
}) {
  const mine = role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        // `dir="auto"` so an Arabic turn lays itself out right-to-left and an
        // English one does not. The two are mixed constantly in a real call.
        dir="auto"
        className={[
          'max-w-[85%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed break-words transition-all duration-200',
          mine
            ? 'bg-brand-primary/10 text-content-primary rounded-br-md'
            : speaking
              ? 'bg-surface-elevated text-content-primary rounded-bl-md ring-1 ring-brand-primary/40 shadow-sm'
              : 'bg-surface-sunken text-content-secondary rounded-bl-md',
          live ? 'opacity-85' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span>{text}</span>
        {speaking ? (
          <span className="inline-flex items-center gap-0.5 ml-2 align-middle" aria-label="Speaking">
            <span className="w-1 h-2 bg-brand-primary rounded-full animate-pulse" />
            <span className="w-1 h-3.5 bg-brand-primary rounded-full animate-pulse [animation-delay:150ms]" />
            <span className="w-1 h-2 bg-brand-primary rounded-full animate-pulse [animation-delay:300ms]" />
          </span>
        ) : null}
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
