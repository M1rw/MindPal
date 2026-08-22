import type { VoiceEvent } from "../adapter/event-types";
import {
  logicalTurnKey,
  normalizeTranscriptText,
  TranscriptAssemblerBase,
  transcriptPayload,
  type TranscriptAssemblerOptions,
  type TranscriptUpdate,
} from "./assembler";

export class AssistantAssembler extends TranscriptAssemblerBase {
  private readonly activeText = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly finalizationSet = new Set<string>();

  public constructor(options: TranscriptAssemblerOptions = {}) {
    super(options);
  }

  public consume(event: VoiceEvent): TranscriptUpdate | null {
    if (event.type === "PROVIDER_INTERNAL_THOUGHT_FILTERED") return null;
    if (event.type !== "PROVIDER_OUTPUT_TRANSCRIPT") return null;
    const payload = transcriptPayload(event);
    if (!payload) return null;

    const text = normalizeTranscriptText(payload.text);
    const key = logicalTurnKey(event.identity, "assistant");
    if (!text) {
      return this.reject({
        type: "transcript.empty.rejected",
        speaker: "assistant",
        logicalTurnKey: key,
        reason: "empty assistant transcript",
      });
    }
    if (payload.isFinal === true && this.finalizationSet.has(key)) {
      return this.reject({
        type: "transcript.duplicate_final.rejected",
        speaker: "assistant",
        logicalTurnKey: key,
        reason: "logical assistant turn already finalized",
      });
    }

    const previous = this.activeText.get(key) ?? "";
    const nextText = reconcileSnapshot(previous, text, payload.cumulative === true);
    this.activeText.set(key, nextText);
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);
    if (payload.isFinal === true) this.finalizationSet.add(key);

    return this.emitUpdate({
      speaker: "assistant",
      text: nextText,
      isFinal: payload.isFinal === true,
      cumulative: payload.cumulative === true,
      identity: event.identity,
      logicalTurnKey: key,
      revision,
    });
  }

  public reset(identity?: { readonly sessionGeneration: string; readonly turnId: string | null }): void {
    if (!identity) {
      this.activeText.clear();
      this.revisions.clear();
      this.finalizationSet.clear();
      return;
    }
    const prefix = `assistant:${identity.sessionGeneration}:${identity.turnId ?? "no-turn"}:`;
    for (const key of this.activeText.keys()) {
      if (key.startsWith(prefix)) this.activeText.delete(key);
    }
  }

  public get activeTextSnapshot(): ReadonlyMap<string, string> {
    return this.activeText;
  }

  public get finalizedTurns(): ReadonlySet<string> {
    return this.finalizationSet;
  }
}

function reconcileSnapshot(previous: string, incoming: string, cumulative: boolean): string {
  if (!previous) return incoming;
  if (incoming === previous) return previous;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  if (cumulative) return incoming;
  return `${previous} ${incoming}`.replace(/\s+/gu, " ").trim();
}
