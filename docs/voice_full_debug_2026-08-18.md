# MindPal Voice Full Debug — 2026-08-18

**Status:** Active investigation. This record separates confirmed production evidence from hypotheses that still require telemetry or a real spoken session.

## 1. Confirmed production baseline

The deployed native Voice release is commit `133ffc8` and Vercel deployment `dpl_GxWiSWgMnGTKowYF6GLx47k847Pj`. A production browser session progressed through **Connecting → MindPal is speaking → Listening** with no Vercel runtime error in the inspected window. The previous startup failure was not related to the free API tier: production transport telemetry recorded clean WebSocket close code `1007` before setup completion because the constrained ephemeral-token endpoint rejected `setup.proactivity` as an unknown field. The current release omits that field.

> The official capability guide documents `proactivity` for a v1beta Live configuration, but MindPal's secure browser transport uses the constrained ephemeral-token WebSocket surface. The production provider response is the controlling compatibility evidence for this application path. [1] [2]

## 2. Current Voice data flow

| Layer | Module(s) | Current responsibility | Debug relevance |
|---|---|---|---|
| Overlay and captions | `frontend/js/voice_live.js`, `frontend/index.html`, `frontend/css/style.css` | Opens the call, stores user and AI transcript strings, renders AI-only caption nodes, scrolls them, and hides the overlay on stop | The live caption surface receives text only through `onTranscript("ai", text)`; it does not synthesize captions from audio itself. |
| Audio transport | `frontend/js/voice/runtime.js` | Gets a token, opens the Live WebSocket, configures audio, sends PCM, decodes model PCM output, and owns reconnects | Native session setup now succeeds. The runtime independently processes audio and output transcription. |
| Turn and activity policy | `conversation_policy.js`, `session_policy.js`, `recovery_policy.js` | Uses provider VAD as the semantic turn owner; local RMS is capture-quality only | Incorrect turn state can make responses feel delayed, cut off, or prematurely generic. |
| Prompt and response strategy | `prompts.js` | Builds the system prompt plus recent turn, memory, time, emotion, and selected mode guidance | The current prompt is long, overlapping, and contains multiple generic-empathy examples and repeated response-shaping rules. This is a likely contributor to flat output. |
| Current-fact workflow | `fact_verifier.js`, `runtime.js`, `backend/api/voice_router.py` | Gates volatile facts until backend-verified evidence is returned | It must be validated that a spoken bridge is delivered, that speculative output is suppressed, and that the verified result resumes the active conversation. |
| Post-call persistence | `voice_live.js`, `app.js`, `voice_summary.js` | Persists user/AI transcripts into a Voice call artifact and creates a summary when transcripts exist | Live-caption loss and post-call transcript loss must be distinguished; they are separate surfaces. |

## 3. Caption disappearance: confirmed paths and hypotheses

### Confirmed paths

The overlay resets `#voice-transcript-panel` only when a **new call** starts. During a call, `handleTranscript("ai", text)` appends an AI caption node and scrolls to it. User transcripts deliberately do not appear in the live caption panel. On normal stop, the overlay is hidden after 500 ms, but the panel is not explicitly cleared until the next call.

The model audio pipeline and caption pipeline are separate. `playAiAudioChunk()` plays `modelTurn.parts[].inlineData` PCM audio, while the caption panel updates only from `serverContent.outputTranscription.text`. Therefore MindPal can audibly speak while no caption appears if the provider does not emit output transcription in the expected server event shape, if it arrives after an event is gated, or if CSS makes the rendered caption effectively invisible.

### Active hypotheses

| Hypothesis | Evidence so far | Required proof | Priority |
|---|---|---|---|
| The native model produces audio but no `outputTranscription` events on the constrained transport | A live browser validation showed **MindPal is speaking** without visible caption text; code only captions output transcription | Aggregate provider-event telemetry: audio chunk count, output-transcription chunk count, and caption-render count, with no transcript content | Critical |
| The CSS design makes prior or current captions appear lost | Older captions have low-contrast color; the track uses top and bottom transparent mask zones; only the active line is large and dark | Rendered-session inspection with a non-empty caption and computed geometry/visibility | High |
| The caption turn reset creates an overly fragmented or off-screen caption stream | `currentCaption` is reset for each user transcript and on provider turn completion | Event timeline correlating provider turn completion with caption node creation and scroll position | High |
| User means the post-call card loses the spoken text | Voice calls are reduced into a summary card after stop; the live panel is intentionally hidden | Inspect the `app.js` persistence/summarization path and actual stored call artifact | Medium |

## 4. Response-quality diagnosis: initial findings

The current Voice prompt has good safety boundaries but attempts to control persona, rhythm, empathy, practical advice, emotional categories, research, safety, language, mode behavior, and output style in one large static instruction. It simultaneously insists on one-to-three sentences, emotional warmth, a precise response, a useful move, natural questioning, voice-tone adaptation, and different background behaviors. This overload gives the model many safe generic patterns to choose from, especially phrases such as *"That sounds really tough"* or a broad follow-up question.

The revised design will use a compact base personality plus a deterministic **turn response plan** generated from the latest provider transcription. The plan will specify an appropriate response shape—not a canned answer—such as direct answer, concrete practical move, reflective insight, short connection, fact-verification bridge, or safety escalation. The model will still author the words, but it will be prohibited from using generic empathy as a substitute for a specific observation, distinction, or next action. This aligns with dialogue-quality research that emphasizes context-conditioned empathy, coherent turn-level strategy, and intentional follow-up selection. [3] [4]

## 5. Provider boundary

| Behavior | Current free-tier constrained native transport | Product posture |
|---|---|---|
| Native voice, Kore identity, multilingual audio | Confirmed startup and Listening state | Enabled |
| Continuous microphone and provider VAD barge-in | Implemented; requires real-speech validation | Enabled with tests |
| AI-only captions | Implemented but not yet proven to receive native output-transcription events | Under active debug |
| Spoken response after the user yields | Supported through native audio | Enabled |
| Spoken bridge after verified fact work | Runtime path exists; real delivery must be tested | Under active debug |
| Provider-driven acknowledgement while the user is still talking | Constrained endpoint rejects the required `proactivity` setup field | Not claimed or faked |
| Provider functions / non-blocking functions | Disabled during native preview stabilization | Current facts use backend evidence route |

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Gemini Live API capabilities guide"
[2]: https://ai.google.dev/api/live "Gemini Live API WebSocket reference"
[3]: https://aclanthology.org/2022.acl-long.211/ "A taxonomy of empathetic questions in social dialogs"
[4]: https://aclanthology.org/W19-8608/ "Towards coherent and engaging spoken dialog response generation using automatic conversation evaluators"

## Next evidence collection

The next production diagnostic release will report aggregate, content-free per-turn values: provider audio parts received, output-transcription parts received, input-transcription parts received, rendered AI-caption count, caption character count, turn-complete count, and whether a fact gate was active. It will explicitly reject transcript or audio payload fields. This distinguishes delivery failure from rendering failure without collecting private spoken content.

The subsequent response-quality release will introduce an audited response-plan selector and golden Voice transcripts for personal dilemmas, practical questions, factual questions, short social turns, Arabic turns, and interruptions.

## Limitations

No conclusion is yet made about the user's subjective report that MindPal is "still dumb." That report is valid product evidence. The next phases will measure and correct the concrete strategy and transcript/rendering paths that can cause it rather than relabeling a connection fix as an intelligence fix.
