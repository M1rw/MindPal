/** Runtime boundary for live call orchestration and narrow ports. */
export { LiveVoiceSession } from '../call/callController.ts';
export type { LiveCallReceipt, LiveSessionCallbacks } from '../call/callTypes.ts';
export type { CallDeps, ControlPort, MicPort, PlaybackPort, TransportPort } from '../call/deps.ts';
export { transition, isLive } from '../call/callMachine.ts';
export type { CallEvent, CallPhase } from '../call/callMachine.ts';
