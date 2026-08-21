import type { GenerationIdentity } from "../../core/layer-link";
import type { VoiceEvent } from "../adapter/event-types";
import {
  logicalTurnKey,
  normalizeTranscriptText,
  TranscriptAssemblerBase,
  transcriptPayload,
  type TranscriptAssemblerOptions,
  type TranscriptUpdate,
} from "./assembler";

export type UserTranscriptContext = {
  readonly mutedAtMono?: number;
  readonly receivedAtMono?: number;
};

export class UserAssembler extends TranscriptAssemblerBase {
  private readonly activeText = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly finalizationSet = new Set<string>();

  public constructor(options: TranscriptAssemblerOptions = {}) {
    super(options);
  }

  public consume(event: VoiceEvent, context: UserTranscriptContext = {}): TranscriptUpdate | null {
    if (event.type !== "PROVIDER_INPUT_TRANSCRIPT") return null;
    const payload = transcriptPayload(event);
    if (!payload) return null;
    const text = normalizeTranscriptText(payload.text);
    const key = logicalTurnKey(event.identity, "user");
    const receivedAt = context.receivedAtMono ?? Number.POSITIVE_INFINITY;
    if (
      context.mutedAtMono !== undefined &&
      receivedAt >= context.mutedAtMono &&
      context.mutedAtMono - receivedAt <= 100
    ) {
      return this.reject({
        type: "transcript.muted_race.rejected",
        speaker: "user",
        logicalTurnKey: key,
        reason: "input transcript arrived within the mute boundary",
      });
    }
    if (!text) {
      return this.reject({
        type: "transcript.empty.rejected",
        speaker: "user",
        logicalTurnKey: key,
        reason: "empty input transcript",
      });
    }
    if (payload.isFinal === true && this.finalizationSet.has(key)) {
      return this.reject({
        type: "transcript.duplicate_final.rejected",
        speaker: "user",
        logicalTurnKey: key,
        reason: "logical input turn already finalized",
      });
    }

    const previous = this.activeText.get(key) ?? "";
    const nextText = payload.cumulative === true || text.startsWith(previous)
      ? text
      : joinTranscript(previous, text);
    this.activeText.set(key, nextText);
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    if (payload.isFinal === true) this.finalizationSet.add(key);

    return this.emitUpdate({
      speaker: "user",
      text: nextText,
      isFinal: payload.isFinal === true,
      cumulative: payload.cumulative === true,
      identity: event.identity,
      logicalTurnKey: key,
      revision,
    });
  }

  public reset(identity?: GenerationIdentity): void {
    if (!identity) {
      this.activeText.clear();
      this.revisions.clear();
      this.finalizationSet.clear();
      return;
    }
    const prefix = `user:${identity.sessionGeneration}:${identity.turnId ?? "no-turn"}:`;
    for (const key of this.activeText.keys()) {
      if (key.startsWith(prefix)) this.activeText.delete(key);
    }
  }

  public getFinalizedTurns(): ReadonlySet<string> {
    return this.finalizationSet;
  }
}

function joinTranscript(previous: string, next: string): string {
  if (!previous) return next;
  if (!next) return previous;
  return `${previous} ${next}`.replace(/\s+/gu, " ").trim();
}
