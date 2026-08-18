const BACKCHANNEL_PROMPTS = Object.freeze({
  empathy: "Give one very short natural listening acknowledgement in the user's current language, such as 'I hear you' or the natural equivalent. Do not ask a question or give advice.",
  validation: "Give one very short natural acknowledgement that validates the user's feeling in the user's current language without escalating it. Do not ask a question or give advice.",
  attentive: "Give one very short natural acknowledgement that shows you are following the user's story in the user's current language. Do not answer yet and do not ask a question.",
  encouragement: "Give one very short natural listening acknowledgement such as 'mm-hm', 'yeah', or 'go on', using the user's current language. Do not answer yet and do not ask a question.",
  checking: "Say one short natural waiting phrase in the user's current language, such as 'give me a second, I\u2019m checking that properly'. Do not answer the question yet.",
  calculating: "Say one short natural waiting phrase in the user's current language while you work out the calculation. Do not give the result yet.",
  remembering: "Say one short natural waiting phrase in the user's current language while you look back at the relevant context. Do not answer yet.",
  researching: "Say one short natural waiting phrase in the user's current language while you check the requested information. Do not answer yet.",
  "checking-details": "Say one short natural waiting phrase in the user's current language while you check the details. Do not answer yet.",
});

export function createBackchannelProvider({
  provider,
  capabilities = {},
  onEvent = () => {},
} = {}) {
  if (!provider) throw new TypeError("provider is required");

  async function request(request = {}) {
    if (!capabilities.sameSessionBackchannel) {
      onEvent({ type: "backchannel.skipped", reason: "capability-not-validated", request });
      return { ok: false, skipped: true, reason: "capability-not-validated" };
    }
    const prompt = BACKCHANNEL_PROMPTS[request.kind] || BACKCHANNEL_PROMPTS.attentive;
    const language = request.language || "auto";
    const cueText = `[LISTENING_ACK_ONLY] ${prompt} The detected conversation language is ${language}. Speak only the short acknowledgement now, in the same voice and language as the active conversation.`;
    const sent = provider.sendClientContent?.([{ role: "user", parts: [{ text: cueText }] }], true) === true
      || provider.sendText?.(cueText) === true;
    if (!sent) {
      onEvent({ type: "backchannel.skipped", reason: "provider-not-ready", request });
      return { ok: false, skipped: true, reason: "provider-not-ready" };
    }
    onEvent({ type: "backchannel.requested", request, transport: provider.sendClientContent ? "client-content" : "realtime-text" });
    return { ok: true, request, transport: provider.sendClientContent ? "client-content" : "realtime-text" };
  }

  return Object.freeze({ request, getPrompt: (kind) => BACKCHANNEL_PROMPTS[kind] || BACKCHANNEL_PROMPTS.attentive });
}

export { BACKCHANNEL_PROMPTS };
