/**
 * The call as a state machine.
 *
 * Pure: `(state, event) -> { phase, effects }`, no timers and no I/O, so every
 * transition is a unit test. Turn-taking itself belongs to Gemini Live (its own
 * voice activity detection decides when the caller started and stopped, and it
 * sends `interrupted` on a barge-in). This machine only tracks what the app has
 * to show and do in response.
 */

export type CallPhase =
  | 'idle'
  | 'connecting'
  /** Nobody is talking and nothing is owed. */
  | 'listening'
  /** Caller words are arriving. */
  | 'userSpeaking'
  /** The caller finished; MindPal owes a reply. */
  | 'waitingReply'
  /** MindPal's audio is playing. */
  | 'speaking'
  | 'reconnecting'
  | 'ended';

export type CallEvent =
  | { type: 'connect' }
  | { type: 'ready' }
  /** A caption delta with real words in it. */
  | { type: 'userWords' }
  /** No new caller words for the pause window. `spoke`: any words this turn. */
  | { type: 'userPaused'; spoke: boolean }
  | { type: 'modelAudio' }
  /** Gemini detected the caller talking over MindPal. */
  | { type: 'interrupted' }
  | { type: 'playbackIdle' }
  | { type: 'dropped' }
  | { type: 'end' };

export type CallEffect =
  /** Close the caller's utterance: transcript bubble plus safety classification. */
  | 'commitUser'
  | 'thinkingOn'
  | 'thinkingOff'
  /** Stop MindPal's audio now. */
  | 'flushPlayback';

export interface Transition {
  phase: CallPhase;
  effects: CallEffect[];
}

const LIVE: ReadonlySet<CallPhase> = new Set(['listening', 'userSpeaking', 'waitingReply', 'speaking']);

export function isLive(phase: CallPhase): boolean {
  return LIVE.has(phase);
}

function stay(phase: CallPhase): Transition {
  return { phase, effects: [] };
}

export function transition(phase: CallPhase, event: CallEvent): Transition {
  if (phase === 'ended') return stay(phase);
  if (event.type === 'end') {
    return { phase: 'ended', effects: phase === 'waitingReply' ? ['thinkingOff'] : [] };
  }

  switch (event.type) {
    case 'connect':
      return phase === 'idle' ? { phase: 'connecting', effects: [] } : stay(phase);

    case 'ready':
      return phase === 'connecting' || phase === 'reconnecting' ? { phase: 'listening', effects: [] } : stay(phase);

    case 'dropped':
      if (!isLive(phase)) return stay(phase);
      return { phase: 'reconnecting', effects: phase === 'waitingReply' ? ['thinkingOff'] : [] };

    case 'userWords':
      if (phase === 'listening') return { phase: 'userSpeaking', effects: [] };
      // They carried on after a pause: the reply is no longer owed yet.
      if (phase === 'waitingReply') return { phase: 'userSpeaking', effects: ['thinkingOff'] };
      // While MindPal talks, overlapping words are Gemini's call: it sends
      // `interrupted` if they took the floor, and nothing if they did not.
      return stay(phase);

    case 'userPaused':
      if (phase !== 'userSpeaking') return stay(phase);
      // An interrupt with no words after it (a cough, a door) owes no reply.
      return event.spoke
        ? { phase: 'waitingReply', effects: ['commitUser', 'thinkingOn'] }
        : { phase: 'listening', effects: [] };

    case 'modelAudio':
      if (phase === 'userSpeaking') return { phase: 'speaking', effects: ['commitUser'] };
      if (phase === 'waitingReply') return { phase: 'speaking', effects: ['thinkingOff'] };
      if (phase === 'listening') return { phase: 'speaking', effects: [] };
      return stay(phase);

    case 'interrupted':
      return phase === 'speaking' ? { phase: 'userSpeaking', effects: ['flushPlayback'] } : stay(phase);

    case 'playbackIdle':
      return phase === 'speaking' ? { phase: 'listening', effects: [] } : stay(phase);
  }
}
