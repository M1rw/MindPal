/**
 * Copy and affordances for live-voice stay-support and escalate-pause.
 * Kept out of the overlay so the guarantees below are unit-testable without a DOM.
 */

import type { LiveUiStatus } from '../types.ts';

export interface CrisisResource {
  id: string;
  label: string;
  detail: string;
  href: string;
}

/**
 * Real, dialable handoffs. `tel:`/`sms:` open the device dialer; nothing here
 * claims MindPal contacts anyone on the user's behalf, because it does not.
 */
export const CRISIS_RESOURCES: ReadonlyArray<CrisisResource> = [
  {
    id: 'lifeline-call',
    label: 'Call 988',
    detail: 'Suicide and Crisis Lifeline (US)',
    href: 'tel:988',
  },
  {
    id: 'lifeline-text',
    label: 'Text 988',
    detail: 'Same lifeline, by message',
    href: 'sms:988',
  },
  {
    id: 'crisis-text-line',
    label: 'Text HOME to 741741',
    detail: 'Crisis Text Line',
    href: 'sms:741741?&body=HOME',
  },
];

export const STAY_STATUS_LABEL = 'Still with you';
export const STAY_SUPPORT_STATUS = STAY_STATUS_LABEL;

export const STAY_DISCLAIMER =
  'MindPal is not a crisis line and cannot keep you safe. 988 and 741741 are available if you want them.';

export const STAY_SUPPORT_HINT = STAY_DISCLAIMER;

export const CRISIS_HEADING = 'The call is paused';

export const CRISIS_BODY =
  'MindPal paused the spoken reply because harm looked imminent, you asked for these numbers or for text, or the call could not keep going in audio. Your microphone is off and nothing more is being sent.';

export function crisisPauseBody(kind?: string, override = ''): string {
  const custom = override.trim();
  if (custom) return custom;
  if (kind === 'physical') {
    return 'MindPal paused the spoken call because you described immediate physical danger. Use your local emergency number if you can. 988 is also available.';
  }
  if (kind === 'self_harm') {
    return 'MindPal paused the spoken call because you described harm that looked imminent.';
  }
  return CRISIS_BODY;
}

/** Says what the detection is, and is not. Do not soften this into a guarantee. */
export const CRISIS_DISCLAIMER =
  'This pause is not clinical screening and does not catch every crisis. MindPal is not a crisis line and cannot contact anyone for you. If you are in danger, use your local emergency number.';

export const CRISIS_HANDOFF_LABEL = 'Continue in text chat';

export const CRISIS_HANDOFF_TOAST =
  'Crisis resources were added to your chat so they stay available.';

/**
 * Mute must work whenever a session exists, including during stay-support and
 * a freeze. Mute stays user-controlled during stay-support.
 */
export function canOperateMute(status: LiveUiStatus, hasSession: boolean): boolean {
  if (!hasSession) return false;
  // No microphone exists before consent, and none survives a failed session.
  return status !== 'consent' && status !== 'unavailable' && status !== 'error';
}

/** True while the overlay is showing crisis resources that must not be silently discarded. */
export function isCrisisSurface(status: LiveUiStatus, crisisScript: string): boolean {
  return status === 'crisis_freeze' || status === 'stay_support' || crisisScript.trim().length > 0;
}
