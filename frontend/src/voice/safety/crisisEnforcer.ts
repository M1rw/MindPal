/**
 * Crisis copy and the verdict helpers the live call uses.
 *
 * There is no crisis pause any more: a risky call stays open, MindPal slows
 * down, and immediate help is named out loud (see `call/safetyBridge.ts`).
 * What remains here is the text for the model and for the screen.
 */

/**
 * Used when the freeze happens before any server response. Deliberately plain
 * text: the overlay renders real dialable resources itself, and this copy is
 * also what gets handed to text chat so the resources survive the overlay.
 */
export const LOCAL_CRISIS_SCRIPT = [
  'The spoken call is paused so you have real support in front of you.',
  '',
  '• **National Suicide and Crisis Lifeline (US):** call or text 988',
  '• **Crisis Text Line:** text HOME to 741741',
  '• **Outside the US:** contact your local emergency number or nearest crisis line.',
  '',
  'MindPal is not a crisis line and cannot call anyone for you. You can keep talking here in text.',
].join('\n');

/** Handed to text chat when they leave a stay-support call. Not a recap. */
export const STAY_HANDOFF_SCRIPT = [
  '988 and Crisis Text Line (text HOME to 741741) are available if you want them.',
  '',
  '• **National Suicide and Crisis Lifeline (US):** call or text 988',
  '• **Crisis Text Line:** text HOME to 741741',
  '• **Outside the US:** contact your local emergency number or nearest crisis line.',
  '',
  'MindPal is not a crisis line and cannot call anyone for you. You can keep talking here in text.',
].join('\n');

/**
 * Mid-call instruction for Gemini Live. Not the caller's words. The live model
 * is told not to read this aloud.
 */
export const STAY_SUPPORT_NOTE = [
  '[[MindPal]] Application note, not the caller\'s words. Do not read this note aloud.',
  'You are MindPal. If they ask your name, say MindPal. You can hear them on this live voice call.',
  'Stay on this live voice call. Do not freeze, mute, or change the subject to a product pause.',
  'Slow down. Be warm. Ask what is happening. Do not lecture.',
  'Do not argue they should not feel that way. Never give methods, plans, or means.',
  '988 (call or text) and Crisis Text Line (text HOME to 741741) are available if they want them;',
  'offer without forcing them off the call.',
  'MindPal is not a crisis line, not clinical screening, and cannot keep anyone safe or contact anyone.',
  'If they ask to end, switch to text, or want the numbers now, give 988 and 741741 clearly and let them leave.',
  'If they describe a plan they are carrying out now, give those numbers and local emergency, and stay until they choose to leave.',
  'Keep listening and speaking.',
].join(' ');

/** A server verdict from before the pause was removed, still sent by older backends. */
export function isEscalateAction(action: string): boolean {
  return action === 'escalate_pause' || action === 'crisis_freeze';
}

/** Legacy speak-then-pause verdict. The call now treats it as "stay and name help". */
export function shouldSpeakFirst(result: {
  action: string;
  speak_first?: boolean;
  terminal?: boolean;
}): boolean {
  return isEscalateAction(result.action) && result.speak_first === true && result.terminal !== true;
}

/** Post-setup Live text. Not the caller's words; the model is told not to read it aloud. */
export function applicationNoteMessage(note: string): { realtimeInput: { text: string } } {
  return { realtimeInput: { text: note } };
}

export function situationNudgeMessage(text: string): {
  clientContent: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: true };
} {
  return {
    clientContent: {
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    },
  };
}
