/** What the call reports to the UI, and what it hands back when it ends. */
import type { VoiceTraceReport } from '../diagnostics/trace.ts';
import type { AffectLevels } from '../face/affect.ts';
import type { VisualBackchannel } from '../face/backchannel.ts';
import type { ActiveExpression } from '../face/expressionCommand.ts';
import type { ListenerReaction } from '../face/listenerReaction.ts';
import type { ProsodySnapshot } from '../face/prosody.ts';
import type { FloorState, LiveUiStatus } from '../types.ts';

export interface LiveCallReceipt {
  sessionId: string;
  inputTranscript: string;
  outputTranscript: string;
  reason: string;
  crisis: boolean;
  usedS: number;
}

export interface LiveSessionCallbacks {
  onStatus: (status: LiveUiStatus, detail?: string) => void;
  onEnergy: (rms: number) => void;
  onPlaybackEnergy?: (envelope: number, brightness?: number) => void;
  onVoiceId?: (voiceId: string) => void;
  onQuota?: (sessionLimitS: number, quotaRemainingS: number) => void;
  onFloor?: (floor: FloorState) => void;
  /** What the caller is saying right now. Replaced constantly. */
  onInputCaption: (text: string) => void;
  /** What MindPal is saying right now. Replaced constantly. */
  onOutputCaption: (text: string) => void;
  /** A finished turn. History: only ever appended. */
  onTurn?: (role: 'user' | 'model', text: string) => void;
  /** True between the caller finishing and the first sound of the reply. */
  onThinking?: (thinking: boolean) => void;
  onCrisis?: (script: string, pauseBody?: string) => void;
  onMuted?: (muted: boolean) => void;
  onFallback: (message: string) => void;
  onEnded?: (receipt: LiveCallReceipt) => void | Promise<void>;
  onExpression?: (command: ActiveExpression | null) => void;
  onCommands?: (commands: ActiveExpression[]) => void;
  onProsody?: (snapshot: ProsodySnapshot) => void;
  onAffect?: (levels: AffectLevels) => void;
  onDistress?: (active: boolean) => void;
  onBackchannel?: (event: VisualBackchannel | null, engagement: number) => void;
  /** MindPal's face reacting while the caller talks. */
  onReaction?: (reaction: ListenerReaction) => void;
  /** Flight recorder for the finished call: timeline plus derived findings. */
  onTrace?: (report: VoiceTraceReport) => void;
}
