import { describe, expect, it } from "vitest";
import fixture from "./fixtures/gemini-events.json";
import { GeminiProviderAdapter, normalizeGeminiMessage } from "./gemini-adapter";
import type { VoiceEvent } from "./event-types";

function allFixtureEvents(): VoiceEvent[] {
  const adapter = new GeminiProviderAdapter();
  return fixture.flatMap((message) => adapter.normalize(message));
}

describe("GeminiProviderAdapter", () => {
  it("normalizes every fixture message and splits multipart model turns", () => {
    const events = allFixtureEvents();
    const types = events.map((event) => event.type);

    expect(types).toContain("PROVIDER_READY");
    expect(types).toContain("PROVIDER_RESUMPTION_UPDATED");
    expect(types).toContain("PROVIDER_INPUT_TRANSCRIPT");
    expect(types).toContain("PROVIDER_OUTPUT_TRANSCRIPT");
    expect(types).toContain("PROVIDER_AUDIO");
    expect(types).toContain("PROVIDER_TOOL_CALL");
    expect(types).toContain("PROVIDER_INTERRUPTED");
    expect(types).toContain("PROVIDER_TURN_COMPLETE");
    expect(types).toContain("PROVIDER_GOAWAY");
    expect(types).toContain("PROVIDER_ERROR");
    expect(types).toContain("PROVIDER_INTERNAL_THOUGHT_FILTERED");

    expect(types.filter((type) => type === "PROVIDER_AUDIO")).toHaveLength(2);
    expect(types.filter((type) => type === "PROVIDER_INTERNAL_THOUGHT_FILTERED")).toHaveLength(1);
  });

  it("preserves cumulative transcript metadata and attaches provider identities", () => {
    const events = allFixtureEvents();
    const output = events.find(
      (event) =>
        event.type === "PROVIDER_OUTPUT_TRANSCRIPT" &&
        event.payload.text === "I hear you, please continue.",
    );
    const audio = events.find(
      (event) => event.type === "PROVIDER_AUDIO" && event.payload.dataBase64 === "AQIDBA==",
    );

    expect(output).toMatchObject({
      type: "PROVIDER_OUTPUT_TRANSCRIPT",
      identity: {
        turnId: "turn-fixture-1",
        providerResponseId: "response-fixture-1",
      },
      payload: { isFinal: false, cumulative: true },
    });
    expect(audio).toMatchObject({
      type: "PROVIDER_AUDIO",
      payload: { sampleRate: 24_000, mimeType: "audio/pcm;rate=24000" },
    });
  });

  it("filters internal thought parts instead of emitting them as output captions", () => {
    const events = allFixtureEvents();
    const filtered = events.find((event) => event.type === "PROVIDER_INTERNAL_THOUGHT_FILTERED");
    const leaked = events.some(
      (event) =>
        event.type === "PROVIDER_OUTPUT_TRANSCRIPT" &&
        event.payload.text.includes("Internal response plan"),
    );

    expect(filtered).toMatchObject({
      payload: {
        reason: "part.thought",
        text: "Internal response plan: decide how to answer.",
      },
    });
    expect(leaked).toBe(false);
  });

  it("normalizes interruption and turn completion from one server message", () => {
    const [interrupted, complete] = normalizeGeminiMessage({
      serverContent: {
        turnId: "turn-2",
        interrupted: true,
        turnComplete: true,
      },
    }).filter(
      (event) => event.type === "PROVIDER_INTERRUPTED" || event.type === "PROVIDER_TURN_COMPLETE",
    );

    expect(interrupted?.type).toBe("PROVIDER_INTERRUPTED");
    expect(complete?.type).toBe("PROVIDER_TURN_COMPLETE");
    expect(interrupted?.identity.turnId).toBe("turn-2");
    expect(interrupted?.identity.providerResponseId).toBeNull();
  });

  it("accepts binary JSON payloads and rejects malformed payloads as provider errors", () => {
    const binary = new TextEncoder().encode(
      JSON.stringify({ serverContent: { input_transcription: "binary input" } }),
    ).buffer;
    const binaryEvents = normalizeGeminiMessage(binary);
    expect(binaryEvents).toMatchObject([
      {
        type: "PROVIDER_INPUT_TRANSCRIPT",
        payload: { text: "binary input" },
      },
    ]);

    const malformed = normalizeGeminiMessage("{not-json");
    expect(malformed[0]).toMatchObject({
      type: "PROVIDER_ERROR",
      payload: { error: expect.any(Error) },
    });
  });
});
