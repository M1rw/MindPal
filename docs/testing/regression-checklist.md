# Regression Checklist

Run this before deploy and after touching chat, voice, auth, memory, RAG, or static serving.

Voice:

```txt
- mic starts
- waveform moves while speaking
- silence goes to retry
- silence does not auto-loop
- retry works
- accept puts transcript in input
- cancel closes panel and releases mic
- Arabic voice language works enough or fails clearly
```

Chat context:

```txt
- ask "how many messages"
- ask "what was my last message"
- ask follow-up "are you sure?"
- inspect /api/chat request payload has non-empty history
- regenerate response does not resend as new user message
```

Cloud:

```txt
- login
- send message
- refresh
- message remains
- open same account in another browser/device
- chat appears
- clear chat removes cloud current chat
```

Modes:

```txt
Active Listen:
  reflective, but not generic or dumb

Guided Coach:
  direct practical answer

Cognitive Tools:
  structured analysis when the user asks for analysis or overthinking help
```

Arabic:

```txt
- Egyptian Arabic input gets Egyptian Arabic output
- relationship distress does not produce formal MSA
- no random identity questions
- no partner diagnosis
- safety/control language routes protectively
```

RAG:

```txt
- /api/rag/health returns units_loaded > 0
- failed_files is empty
- panic retrieves panic grounding
- anger retrieves DBT STOP
- overthinking retrieves cognitive reframe
- Arabic relationship distress retrieves boundary/safety
```

Memory:

```txt
- guest memory stays local
- signed-in memory loads from Firestore
- preferred_name overrides Firebase display name
- important_people aliases merge
- user can delete/edit remembered facts once Memory Inspector exists
```

Safety:

```txt
- imminent self-harm bypasses LLM
- abuse_or_violence routes to safety
- no retaliation, stalking, coercion, or self-harm instructions
```

Automated checks:

```powershell
python -m pytest
python -m compileall backend tests -q
node --check frontend/js/app.js
node --check frontend/js/api.js
node --check frontend/js/voice.js
```

