import type { GenerationIdentity } from "../../core/layer-link";
import type { ProviderTranscriptPayload, VoiceEvent } from "../adapter/event-types";

export type TranscriptSpeaker = "user" | "assistant";

export type TranscriptUpdate = {
  readonly speaker: TranscriptSpeaker;
  readonly text: string;
  readonly isFinal: boolean;
  readonly cumulative: boolean;
  readonly identity: GenerationIdentity;
  readonly logicalTurnKey: string;
  readonly revision: number;
};

export type TranscriptAssemblerDiagnostic = {
  readonly type:
    | "transcript.duplicate_final.rejected"
    | "transcript.muted_race.rejected"
    | "transcript.empty.rejected";
  readonly speaker: TranscriptSpeaker;
  readonly logicalTurnKey?: string;
  readonly reason: string;
};

export type TranscriptAssemblerOptions = {
  readonly onUpdate?: (update: TranscriptUpdate) => void;
  readonly onDiagnostic?: (diagnostic: TranscriptAssemblerDiagnostic) => void;
};

export function transcriptPayload(event: VoiceEvent): ProviderTranscriptPayload | null {
  if (
    event.type !== "PROVIDER_INPUT_TRANSCRIPT" &&
    event.type !== "PROVIDER_OUTPUT_TRANSCRIPT"
  ) {
    return null;
  }
  return event.payload;
}

export function logicalTurnKey(identity: GenerationIdentity, speaker: TranscriptSpeaker): string {
  return [
    speaker,
    identity.sessionGeneration,
    identity.turnId ?? "no-turn",
    identity.providerResponseId ?? "no-response",
  ].join(":");
}

export function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export abstract class TranscriptAssemblerBase {
  protected readonly onUpdate: ((update: TranscriptUpdate) => void) | undefined;
  protected readonly onDiagnostic: ((diagnostic: TranscriptAssemblerDiagnostic) => void) | undefined;

  protected constructor(options: TranscriptAssemblerOptions = {}) {
    this.onUpdate = options.onUpdate;
    this.onDiagnostic = options.onDiagnostic;
  }

  protected emitUpdate(update: TranscriptUpdate): TranscriptUpdate {
    this.onUpdate?.(update);
    return update;
  }

  protected reject(diagnostic: TranscriptAssemblerDiagnostic): null {
    this.onDiagnostic?.(diagnostic);
    return null;
  }
}
