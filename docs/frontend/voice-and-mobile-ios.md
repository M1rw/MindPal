# Voice And Mobile iOS

Voice input is a frontend state machine built around browser microphone access and browser speech recognition.

Important distinction:

```txt
getUserMedia()
  gives the app microphone audio for the waveform meter

SpeechRecognition / webkitSpeechRecognition
  asks the browser speech service for transcript text
```

That means the waveform can move while transcription still fails.

Current voice flow:

```txt
click mic
  -> confirm language if needed
  -> getUserMedia starts mic meter
  -> SpeechRecognition starts browser transcription
  -> transcript appears as interim/final result
  -> user accepts transcript into input
```

State rules:

```txt
silence -> no_speech -> retry visible
heard audio but no words -> heard_no_transcript -> retry visible
network/service failure -> network_error -> retry visible
permission denial -> permission_error
cancel -> stop mic and close panel
accept -> put transcript in input and close panel
```

iOS diagnosis:

```txt
The likely mobile iOS problem is not basic mic permission if the waveform moves.
The likely issue is Safari/WebKit SpeechRecognition reliability.
Browser speech recognition is service-backed and browser-dependent.
continuous recognition is especially fragile on mobile Safari.
```

Current risk points:

```txt
recognition.continuous = true
  Mobile Safari often behaves better with shorter utterance sessions.

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
1. iPhone Safari: mic permission prompt appears.
2. Waveform moves when speaking.
3. Silence ends in retry, no auto-loop.
4. Retry starts a clean new run.
5. Transcript appears for English.
6. Arabic locale produces usable transcript or clear failure.
7. Cancel always releases mic indicator.
```

