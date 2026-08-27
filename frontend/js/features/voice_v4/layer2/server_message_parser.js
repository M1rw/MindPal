import {
  isValidAudioPart,
  isValidBase64,
} from "./protocol_contract.js";

const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_GO_AWAY_MS = 86_400_000;

export function parseServerMessage(message) {
  if (!isRecord(message)) return [unknownFact("malformed_message")];

  const facts = [];
  if (isRecord(message.setupComplete)) facts.push({ type: "setup_complete" });
  if (isRecord(message.serverContent)) facts.push(...parseServerContent(message.serverContent));
  if (isRecord(message.goAway)) facts.push(parseGoAway(message.goAway));
  if (isRecord(message.sessionResumptionUpdate)) facts.push(parseResumption(message.sessionResumptionUpdate));
  if (isRecord(message.toolCall) || isRecord(message.toolCallCancellation)) {
    facts.push({ type: "tool_call_unexpected" });
  }
  if (isRecord(message.error)) facts.push({ type: "provider_error", code: "provider_error" });

  return facts.length > 0 ? facts : [unknownFact("unrecognized_message")];
}

function parseServerContent(content) {
  const facts = [];
  if (content.interrupted === true) facts.push({ type: "interrupted" });

  const inputTranscript = safeTranscript(content.inputTranscription?.text);
  if (inputTranscript !== null) facts.push({ type: "input_transcript", text: inputTranscript });

  const outputTranscript = safeTranscript(content.outputTranscription?.text);
  if (outputTranscript !== null) facts.push({ type: "output_transcript", text: outputTranscript });

  const parts = Array.isArray(content.modelTurn?.parts) ? content.modelTurn.parts : [];
  for (const part of parts) facts.push(...parseModelPart(part));

  if (content.generationComplete === true) facts.push({ type: "generation_complete" });
  if (content.turnComplete === true) facts.push({ type: "turn_complete" });
  return facts;
}

function parseModelPart(part) {
  if (!isRecord(part)) return [unknownFact("malformed_model_part")];
  const facts = [];

  if (isValidAudioPart(part)) {
    facts.push({
      type: "model_audio_part",
      mimeType: part.inlineData.mimeType,
      data: part.inlineData.data,
    });
  } else if (part.inlineData) {
    facts.push(unknownFact("invalid_audio_part"));
  }

  const text = safeTranscript(part.text);
  if (text !== null) facts.push({ type: "output_transcript", text });
  if (part.functionCall || part.functionResponse) facts.push({ type: "tool_call_unexpected" });

  return facts.length > 0 ? facts : [unknownFact("unsupported_model_part")];
}

function parseGoAway(payload) {
  const timeLeftMs = boundedInteger(payload.timeLeftMs, MAX_GO_AWAY_MS);
  return timeLeftMs === null ? { type: "go_away" } : { type: "go_away", timeLeftMs };
}

function parseResumption(payload) {
  return {
    type: "session_resumption_update",
    resumable: payload.resumable === true,
    hasHandle: typeof payload.newHandle === "string" && payload.newHandle.length > 0,
  };
}

function safeTranscript(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_TRANSCRIPT_CHARS ? text : null;
}

function boundedInteger(value, maximum) {
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function unknownFact(reason) {
  return { type: "unknown_message", reason };
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isValidAudioData(data) {
  return isValidBase64(data);
}
