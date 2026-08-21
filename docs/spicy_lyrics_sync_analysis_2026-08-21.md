# Spicy Lyrics synchronization analysis — 2026-08-21

The referenced repository is `Spikerko/spicy-lyrics`, inspected from its public `main` branch at commit `a2a511b` and cloned locally under `/home/ubuntu/spicy-lyrics-reference`.

## Reference behavior

Spicy Lyrics does not wait for a new lyric packet to decide which word is active. Its `LyricsSetter.TimeSetter(currentPosition)` receives the live playback position and assigns every word one of three states on every update: `NotSung`, `Active`, or `Sung`. The active state is calculated directly from each word’s `StartTime` and `EndTime`. Its animator then computes continuous progress inside the active word and updates visual properties each animation frame. It also uses per-word transitions/springs and scrolls the active line into view.

The important design property is a stable timestamped word timeline. The text is already mounted, and the playback clock changes only the word state and animation progress. Network events are used to load or update the timeline, not to drive the visual highlight frame by frame.

## MindPal gap

MindPal previously rendered only the latest paced transcript chunk and moved the highlight when another transcript chunk arrived. Gemini output transcription is incremental and can be delayed or cumulative, while PCM playback continues continuously. That makes a packet-driven highlight trail the audio and jump over repeated words. The new implementation keeps the complete assistant response visible immediately and advances a monotonic word cursor from a requestAnimationFrame playback clock. It estimates timing temporarily until measured PCM duration is available, then uses the scheduled playback duration as the timing floor without allowing progress to move backward.

## Implemented target

The new MindPal path uses `caption_word_timeline.js` for Unicode-safe word tokenization, estimated duration, and progress-to-word mapping. `voice_live.js` renders spans for spoken, current, and upcoming words. A continuous animation frame updates the current range, while provider transcript events only extend the full source text and audio diagnostics establish the clock origin and measured duration. Arabic-English text retains the existing directional isolation logic.

This is an adaptation of the reference’s timing principle, not a copy of its Spotify-specific code or visual implementation.

## Production verification note

Commit `03997bc` deployed as Vercel deployment `dpl_43SX71EJKPgBRZ4H3hcWsWH2chNe`, which reached `READY` and was aliased to `mindpal-demo.vercel.app`. The canonical browser session was opened without a query parameter. The Voice greeting was observed in the live overlay; the available greeting was short enough that one captured frame showed only the partial text `Hel` while the session was speaking. This frame is not sufficient evidence for a long-response word-by-word acceptance test, so the implementation is validated by deterministic timing tests and the deployed playback schedule fields, but long-response visual smoothness should still be checked with a deliberately longer spoken turn.
