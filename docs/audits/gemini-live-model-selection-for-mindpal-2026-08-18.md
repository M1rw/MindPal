# Gemini Live Model Selection for MindPal

**Date:** 2026-08-18
**Use case:** MindPal conversational emotional-support voice assistant with full-duplex audio, interruption, memory/tools, current-fact verification, multilingual behavior, and session recovery.

## Recommendation

For the options shown, use **Gemini 2.5 Flash Native Audio Dialog** as the current MindPal production choice.

It is the best fit because it is a general conversational native-audio model, not a translation-only model, and Google documents support for function calling, non-blocking functions, tool-result scheduling, proactive audio, affective dialog, automatic VAD, and barge-in for the Gemini 2.5 Flash Live family.[1] [2]

**Do not use Gemini 3.5 Live Translate for MindPal’s main assistant.** Google explicitly describes it as an interpreter/translation pipeline: audio input to translated audio output, with no function calling, no search grounding, no thinking, no tools, and no instructions.[3]

The label **“Gemini 3 Flash Live” is ambiguous.** Google’s current public model documentation lists `gemini-3-flash-preview` as Gemini 3 Flash and `gemini-3.1-flash-live-preview` as Gemini 3.1 Flash Live; it does not establish the exact API model ID behind the dashboard label “Gemini 3 Flash Live.”[4] Before selecting it, MindPal should inspect the exact model ID and capability profile. If it means Gemini 3.1 Flash Live, it is not automatically better for MindPal: Google’s comparison says Gemini 3.1 does **not** support non-blocking function calling, proactive audio, or affective dialog, while Gemini 2.5 does.[2]

## Comparison

| Option shown | Intended role | MindPal conversational fit | Main limitation | Recommendation |
| --- | --- | --- | --- | --- |
| **Gemini 2.5 Flash Native Audio Dialog** (`gemini-2.5-flash-native-audio-preview-12-2025`) | General low-latency conversational voice agent | **High** | Preview model and current MindPal transport has not yet safely enabled every capability | **Use this now** |
| **Gemini 3 Flash Live** | Exact identity unclear from label; may refer to a Gemini 3 Live variant | Unknown until exact ID is confirmed | Could lack the 2.5 model’s non-blocking tools, proactive audio, or affective dialog depending on actual model | Test before migration |
| **Gemini 3.5 Live Translate** (`gemini-3.5-live-translate-preview`) | Real-time speech-to-speech translation | **Low for MindPal assistant** | Translation only; no tools, instructions, thinking, or search grounding | Use only for a separate translation feature |

## Why 2.5 is currently better for MindPal

MindPal is not merely translating speech. It must listen, reason about emotional context, respond naturally, interrupt safely, use memory and tools, verify volatile facts, follow safety policy, and preserve continuity across reconnects.

Google’s Live Translation documentation distinguishes the two product concepts clearly. A Live Agent acts as an assistant, uses turn-based interactions, supports tools and instructions, and can be multimodal. Live Translation behaves as an interpreter, processes a continuous stream, and supports translation only.[3]

That distinction makes Gemini 3.5 Live Translate unsuitable as the main MindPal brain even though it may have excellent simultaneous speech behavior.

Gemini 2.5 Native Audio is also the least disruptive choice for the current repository because MindPal’s source already targets its exact model ID, `v1beta`, the `Kore` voice, native 16 kHz input/24 kHz output, automatic VAD, and ephemeral-token browser WebSockets.[5] [6]

## About the counters shown

The counters you provided should not be interpreted as model-quality scores:

| Model | User-provided counters |
| --- | --- |
| Gemini 2.5 Native Audio Dialog | `1 / Unlimited`, `876 / 1M`, `3 / Unlimited` |
| Gemini 3 Flash Live | `2 / Unlimited`, `1.41K / 65K`, `48 / Unlimited` |
| Gemini 3.5 Live Translate | `0 / Unlimited`, `0 / 20K`, `0 / Unlimited` |

They appear to be usage or quota counters, not latency, intelligence, interruption quality, or conversational-quality measurements. The higher `1.41K` value for Gemini 3 Flash Live does not prove it is better; it may simply reflect a different quota category or usage amount.

## Decision rule

Use the following decision rule:

1. If the goal is **MindPal’s normal voice assistant**, choose **Gemini 2.5 Flash Native Audio Dialog**.
2. If the goal is **live translation between languages**, choose **Gemini 3.5 Live Translate** in a separate translation mode, not as the MindPal assistant.
3. If “Gemini 3 Flash Live” is actually `gemini-3.1-flash-live-preview`, do not migrate solely because it has a newer number. First compare function calling, tool scheduling, affective dialog, proactive audio, VAD, session limits, and latency on the exact ephemeral-token transport.
4. If Google’s dashboard exposes a newer exact Gemini 3 Live model with verified support for MindPal’s required tools and emotional-dialog features, run an A/B capability probe before changing production.

## Suggested next step

Keep Gemini 2.5 as the production model and create a **model capability probe** rather than switching immediately. Test the current model for continuous mic input, barge-in, non-blocking tools, `WHEN_IDLE` scheduling, `SILENT` evidence results, affective dialog, proactive audio, and reconnect/resumption. Only consider Gemini 3 Flash Live after the exact model ID is identified and it passes the same probe.

## References

[1]: https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025 "Gemini 2.5 Flash Native Audio model page"
[2]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Gemini Live API capability comparison"
[3]: https://ai.google.dev/gemini-api/docs/live-api/live-translate "Gemini Live Translation guide"
[4]: https://ai.google.dev/gemini-api/docs/models "Google Gemini model catalog"
[5]: ../../backend/core/config.py "MindPal backend Live model configuration"
[6]: ../../frontend/js/voice/provider_policy.js "MindPal frontend provider capability policy"

> **Confidence:** High that Gemini 3.5 Live Translate is unsuitable for MindPal’s main assistant. High that Gemini 2.5 Native Audio matches the current repository. Moderate for “Gemini 3 Flash Live” because the exact API model ID behind that label is not established by the public model catalog.
