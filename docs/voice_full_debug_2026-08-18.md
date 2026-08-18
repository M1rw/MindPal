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

### Production evidence and resulting correction

A privacy-safe diagnostic release recorded one controlled native call. The provider produced **45 audio PCM parts**, but emitted **zero input-transcription events**, **zero output-transcription events**, and **zero caption callbacks**. The same trace recorded two model text parts, but no caption-eligible output on the current turn. The user-visible result matched the telemetry: MindPal spoke and then listened, while the AI caption surface stayed empty.

> This is a transport delivery failure, not an opacity-only explanation. MindPal requests `responseModalities: ["AUDIO"]`, `inputAudioTranscription: {}`, and `outputAudioTranscription: {}` exactly as the official Live documentation prescribes. [1] [5]

The native preview is therefore removed as the **production default** until it can prove output-transcript delivery on MindPal's secure constrained session. Production returns to `gemini-3.1-flash-live-preview`, which has already produced the transcript path required by the caption UI. The native policy is retained but cannot be represented as a working captioned call today.

The caption UI is also corrected independently: its aggressive top-and-bottom fade mask is removed, retained AI lines are higher contrast, and scroll padding keeps the current large line clear of the visual edges and controls. This prevents a valid legacy transcript from appearing to slide away.

## 4. Response-quality diagnosis: initial findings

The current Voice prompt has good safety boundaries but attempts to control persona, rhythm, empathy, practical advice, emotional categories, research, safety, language, mode behavior, and output style in one large static instruction. It simultaneously insists on one-to-three sentences, emotional warmth, a precise response, a useful move, natural questioning, voice-tone adaptation, and different background behaviors. This overload gives the model many safe generic patterns to choose from, especially phrases such as *"That sounds really tough"* or a broad follow-up question.

The response-quality correction is now implemented as a compact base personality plus a deterministic **turn response plan** generated from the latest provider transcription. The plan selects an appropriate shape—not a canned answer—such as direct answer, concrete practical move, reflective insight, short connection, fact-verification bridge, or safety escalation. The model still authors the words, but generic empathy cannot substitute for a specific observation, distinction, or next action. Golden tests cover greetings, verified facts, practical dilemmas, emotional focus conflicts, direct questions, and Egyptian Arabic. This follows dialogue-quality research emphasizing context-conditioned empathy, coherent turn-level strategy, and intentional follow-up selection. [3] [4]

## 5. Provider boundary

| Behavior | Native preview on current constrained path | Production posture |
|---|---|---|
| Native voice, Kore identity, multilingual audio | Setup and audio are delivered | Retained for future validation, not the default call path |
| Native AI-only captions | Provider delivered 45 audio parts and zero output transcripts in controlled production trace | Not claimed as working |
| Captioned Voice | Legacy Live transport has the required transcript delivery path | Production default |
| Continuous microphone and provider VAD barge-in | Implemented for both transports; real-speech validation still required | Enabled with tests |
| Spoken response after the user yields | Supported | Enabled |
| Spoken bridge after verified fact work | Runtime path exists; real delivery must be tested | Under active validation |
| Provider-driven acknowledgement while the user is still talking | Constrained endpoint rejected the required `proactivity` setup field | Not claimed or faked |
| Provider functions / non-blocking functions | Disabled during native preview stabilization | Current facts use backend evidence route |

## References

[1]: https://ai.google.dev/gemini-api/docs/live-api/capabilities "Gemini Live API capabilities guide"
[2]: https://ai.google.dev/api/live "Gemini Live API WebSocket reference"
[3]: https://aclanthology.org/2022.acl-long.211/ "A taxonomy of empathetic questions in social dialogs"
[4]: https://aclanthology.org/W19-8608/ "Towards coherent and engaging spoken dialog response generation using automatic conversation evaluators"
[5]: https://firebase.google.com/docs/ai-logic/live-api/configuration "Firebase AI Logic Live API configuration"

## Next validation

The next production release will validate the caption-capable transport through **Connecting → speaking → caption text → Listening**, then run a real spoken call that exercises a natural answer, barge-in, and a verified changing-fact question. The content-free delivery counters remain available for future provider regressions and explicitly reject transcript or audio payload fields.

## Limitations

No conclusion is yet made about the user's subjective report that MindPal is "still dumb." That report is valid product evidence. The next phases will measure and correct the concrete strategy and transcript/rendering paths that can cause it rather than relabeling a connection fix as an intelligence fix.
