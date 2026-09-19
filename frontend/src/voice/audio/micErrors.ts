/**
 * Say what actually stopped the microphone.
 *
 * `startPcmCapture` used to sit behind a bare `catch {}` that reported
 * "Microphone permission is required" for every possible failure. Permission is
 * only one of them, and it is not even the most common: a device already held by
 * another tab, a machine with no input at all, and a page served over plain http
 * all land in the same place and all produce a message that sends the caller to
 * a browser setting that was never the problem.
 *
 * The browser already tells us which it was, in `DOMException.name`. This turns
 * that into something true, plus a stable `reason` for the trace so the next
 * report says which one it was rather than repeating the guess.
 */

export interface MicFailure {
  /** Stable, loggable cause. Goes into the trace and the console. */
  reason:
    | 'permission_denied'
    | 'no_device'
    | 'device_busy'
    | 'insecure_context'
    | 'unsupported'
    | 'constraints'
    | 'aborted'
    | 'worklet_blocked'
    | 'unknown';
  /** What the caller is told. Every one of these names a next step. */
  message: string;
  /** The browser's own name for it, for the trace. */
  name: string;
}

const DICTATE = 'You can still dictate into the composer.';

/**
 * True when this page cannot reach a microphone at all.
 *
 * `navigator.mediaDevices` is undefined outside a secure context, so the call
 * throws a TypeError that looks nothing like a permission error. Checked before
 * the call so the message can name the real reason.
 */
export function microphoneApiAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function describeMicFailure(error: unknown): MicFailure {
  // Not a microphone failure at all: the audio worklet never loaded, so there is
  // no capture path. In one real case a Content Security Policy without `blob:`
  // in script-src refused the worklet, and the caller was told their microphone
  // would not start - sending them to a permission setting that was fine.
  const name0 = error instanceof Error ? error.name : '';
  if (name0 === 'CaptureWorkletError' || name0 === 'InvalidStateError') {
    return {
      reason: 'worklet_blocked',
      name: name0,
      message: `Live audio could not be set up in this browser, so the call cannot start. This is not a microphone permission problem. ${DICTATE}`,
    };
  }

  if (!microphoneApiAvailable()) {
    return {
      reason: 'insecure_context',
      name: 'SecurityError',
      message: `This page cannot use the microphone. Live voice needs https (or localhost). ${DICTATE}`,
    };
  }

  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return {
        reason: 'permission_denied',
        name,
        message: `Microphone access was blocked. Allow it for this site in your browser, then start the call again. ${DICTATE}`,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        reason: 'no_device',
        name,
        message: `No microphone was found. Plug one in or pick one in your system sound settings. ${DICTATE}`,
      };
    case 'NotReadableError':
    case 'TrackStartError':
      // The single most misdiagnosed one: the caller HAS granted permission and
      // sending them to permission settings finds nothing wrong there.
      return {
        reason: 'device_busy',
        name,
        message: `Your microphone is in use by another app or tab. Close the other one, then start the call again. ${DICTATE}`,
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        reason: 'constraints',
        name,
        message: `This microphone cannot be opened in the format live voice needs. Try a different input device. ${DICTATE}`,
      };
    case 'AbortError':
      return {
        reason: 'aborted',
        name,
        message: `Starting the microphone was interrupted. Try the call again. ${DICTATE}`,
      };
    case 'SecurityError':
      return {
        reason: 'insecure_context',
        name,
        message: `This page is not allowed to use the microphone. Live voice needs https (or localhost). ${DICTATE}`,
      };
    case 'TypeError':
      return {
        reason: 'unsupported',
        name,
        message: `This browser cannot open a microphone for live voice. ${DICTATE}`,
      };
    default:
      return {
        reason: 'unknown',
        name: name || 'Error',
        message: `The microphone could not be started. Try the call again. ${DICTATE}`,
      };
  }
}
