/**
 * Voice store. Live overlay mounts only when voice_enabled and isActive.
 *
 * Discrete state only. Anything that updates at capture rate (mic energy,
 * prosody, affect, backchannel, distress) goes through `presenceBus` instead —
 * putting it here made every audio frame a React render of the whole overlay.
 */

import { create } from 'zustand';
import { presenceBus } from '../voice/presenceBus.ts';
import type { ActiveExpression } from '../voice/face/expressionCommand.ts';
import type { FloorState, LiveUiStatus } from '../voice/types.ts';

interface VoiceState {
  isActive: boolean;
  isMuted: boolean;
  isCapturing: boolean;
  uiStatus: LiveUiStatus;
  statusDetail: string;
  voiceId: string;
  floor: FloorState;
  /** The utterance being spoken right now. Replaced constantly, never appended. */
  transcript: string;
  aiTranscript: string;
  /** Finished turns, oldest first. Append-only history behind the live caption. */
  turns: VoiceTurn[];
  /** MindPal has the turn but has not made a sound yet. */
  thinking: boolean;
  crisisScript: string;
  crisisPauseBody: string;
  expression: ActiveExpression | null;
  commands: ActiveExpression[];
  sessionLimitS: number;
  quotaRemainingS: number;
  setIsActive: (active: boolean) => void;
  setIsMuted: (muted: boolean) => void;
  setIsCapturing: (capturing: boolean) => void;
  setUiStatus: (status: LiveUiStatus, detail?: string) => void;
  setVoiceId: (voiceId: string) => void;
  setFloor: (floor: FloorState) => void;
  addTurn: (role: VoiceTurn['role'], text: string) => void;
  setThinking: (thinking: boolean) => void;
  setTranscript: (text: string) => void;
  appendAiTranscript: (text: string) => void;
  setAiTranscript: (text: string) => void;
  setCrisisScript: (text: string, pauseBody?: string) => void;
  setExpression: (expression: ActiveExpression | null) => void;
  setCommands: (commands: ActiveExpression[]) => void;
  setQuota: (sessionLimitS: number, quotaRemainingS: number) => void;
  /**
   * Tears down live-call state but keeps `crisisScript`. Closing the overlay is the
   * most likely reflex during a freeze, and it must not delete the resources the
   * freeze just put on screen.
   */
  resetVoice: () => void;
  /** Explicit dismissal, once the script has been handed somewhere persistent. */
  clearCrisis: () => void;
}

export interface VoiceTurn {
  id: string;
  role: 'user' | 'model';
  text: string;
}

/** Enough to scroll back through a long call without unbounded growth. */
const MAX_TURNS = 200;

const idle = {
  isActive: false,
  isMuted: false,
  isCapturing: false,
  uiStatus: 'connecting' as LiveUiStatus,
  statusDetail: '',
  voiceId: 'Sulafat',
  floor: 'idle' as const,
  transcript: '',
  aiTranscript: '',
  turns: [] as VoiceTurn[],
  thinking: false,
  crisisScript: '',
  crisisPauseBody: '',
  expression: null,
  commands: [] as ActiveExpression[],
  sessionLimitS: 0,
  quotaRemainingS: 0,
};

export const useVoiceStore = create<VoiceState>((set) => ({
  ...idle,
  setIsActive: (isActive) =>
    set({
      isActive,
      uiStatus: isActive ? 'consent' : 'connecting',
      sessionLimitS: 0,
      quotaRemainingS: 0,
      // A new call starts with an empty scrollback. The previous call's turns
      // belong to the recap written into the chat thread, not to this screen.
      ...(isActive ? { crisisScript: '', crisisPauseBody: '', turns: [], thinking: false, transcript: '', aiTranscript: '' } : {}),
    }),
  setIsMuted: (isMuted) => set({ isMuted }),
  setIsCapturing: (isCapturing) => set({ isCapturing }),
  setUiStatus: (uiStatus, statusDetail = '') => set({ uiStatus, statusDetail }),
  setVoiceId: (voiceId) => set({ voiceId }),
  setFloor: (floor) => set({ floor }),
  setTranscript: (transcript) => set({ transcript }),
  setThinking: (thinking) => set({ thinking }),
  addTurn: (role, text) =>
    set((state) => {
      const body = text.replace(/\s+/g, ' ').trim();
      if (!body) return state;
      const last = state.turns[state.turns.length - 1];
      // The provider re-sends a finished turn on reconnect and on a late final.
      // Two identical bubbles in a row read as MindPal repeating itself.
      if (last && last.role === role && last.text === body) return state;
      // One thought, one bubble. The local endpointer closes a turn at every
      // ~1s pause, so a single sentence used to arrive as seven "You:" bubbles.
      // Two caller turns with nothing from MindPal between them are one thought.
      if (last && role === 'user' && last.role === 'user') {
        const merged = { ...last, text: `${last.text} ${body}` };
        return { turns: [...state.turns.slice(0, -1), merged] };
      }
      const turns = [...state.turns, { id: `${role}-${state.turns.length}-${Date.now()}`, role, text: body }];
      return { turns: turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns };
    }),
  appendAiTranscript: (text) => set((state) => ({ aiTranscript: state.aiTranscript + text })),
  setAiTranscript: (aiTranscript) => set({ aiTranscript }),
  setCrisisScript: (crisisScript, crisisPauseBody) =>
    set({
      crisisScript,
      ...(typeof crisisPauseBody === 'string' ? { crisisPauseBody } : {}),
    }),
  setExpression: (expression) => set({ expression }),
  setCommands: (commands) => set({ commands, expression: commands[commands.length - 1] ?? null }),
  setQuota: (sessionLimitS, quotaRemainingS) => set({ sessionLimitS, quotaRemainingS }),
  resetVoice: () => {
    presenceBus.reset();
    return set((state) => ({
      ...idle,
      crisisScript: state.crisisScript,
      crisisPauseBody: state.crisisPauseBody,
    }));
  },
  clearCrisis: () => set({ crisisScript: '', crisisPauseBody: '' }),
}));
