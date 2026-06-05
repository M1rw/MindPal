# Voice And Mobile iOS/Android

Voice input is a frontend state machine built around browser microphone access and browser speech recognition.

Important distinction:

```txt
getUserMedia()
  gives the app microphone audio for the waveform meter

SpeechRecognition / webkitSpeechRecognition
  asks the browser speech service for transcript text
```

That means the waveform can move while transcription still fails.

Current desktop voice flow:

```txt
click mic
  -> confirm language if needed
  -> getUserMedia starts mic meter
  -> SpeechRecognition starts browser transcription
  -> transcript appears as interim/final result
  -> user accepts transcript into input
```

Current mobile voice flow:

```txt
click mic
  -> confirm language if needed
  -> synthetic waveform starts for visual feedback
  -> SpeechRecognition starts browser transcription
  -> transcript appears as interim/final result
  -> user accepts transcript into input
```

Mobile intentionally does not start a separate getUserMedia meter before
SpeechRecognition. iOS Safari and Android Chrome are more reliable when the
browser speech service owns microphone capture.

State rules:

```txt
silence -> no_speech -> retry visible
heard audio but no words -> heard_no_transcript -> retry visible
network/service failure -> network_error -> retry visible
permission denial -> permission_error
cancel -> stop mic and close panel
accept -> put transcript in input and close panel
```

iOS/Android diagnosis:

```txt
The likely mobile problem is not basic mic permission if the browser prompt appears.
The likely issue is mobile SpeechRecognition reliability and audio ownership.
Browser speech recognition is service-backed and browser-dependent.
continuous recognition is especially fragile on mobile Safari and some Android Chrome builds.
```

Current risk points:

```txt
desktop:
  uses getUserMedia for the hardware waveform meter
  uses continuous SpeechRecognition

mobile:
  skips getUserMedia meter
  uses non-continuous SpeechRecognition
  shows synthetic waveform only

Browser speech service dependency
  Can return network/service errors even when microphone capture works.

Language support mismatch
  The selected BCP-47 locale may be accepted by the app but weakly supported by Safari speech recognition.

User gesture constraints
  iOS is strict about starting audio work from a direct user action.
```

Best future fix:

```txt
Record short audio clip in browser
send to backend transcription endpoint
transcribe server-side with a known provider
return transcript
keep browser SpeechRecognition as optional fallback
```

Do not do this casually. It changes privacy, backend payloads, provider cost, error handling, and mobile UX.

Regression checklist:

```txt
1. iPhone Safari: speech permission/mic prompt appears.
2. Android Chrome: speech permission/mic prompt appears.
3. Desktop browser: waveform responds to real speech volume.
4. Mobile browser: waveform animates but is not treated as audio detection.
5. Silence ends in retry, no auto-loop.
6. Retry starts a clean new run.
7. Transcript appears for English.
8. Arabic locale produces usable transcript or clear failure.
9. Cancel always releases browser mic indicator.
10. Accept places transcript in the input.
```
