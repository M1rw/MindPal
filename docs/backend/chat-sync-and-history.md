# Chat Sync And History

Chat sync is raw conversation persistence. It is not memory.

Guest mode:

```txt
localStorage owns current chat
no Firestore writes
history is sent to backend from local state
```

Cloud mode:

```txt
Firestore owns current chat
frontend may cache locally
backend chat routes persist current chat/messages
refresh should restore from cloud
second browser should see the same signed-in chat
```

Expected chat context behavior:

```txt
User: "how many messages?"
MindPal: answer from current history count, not an LLM guess.

User: "what was my last message?"
MindPal: answer from latest user message in history.

User: "are you sure?"
MindPal: keep previous context and explain based on actual chat history.
```

Regenerate behavior:

```txt
Regenerate response should not append a new user message.
It should reuse the previous user turn and replace or append a regenerated assistant response according to UI policy.
```

Common failures:

```txt
history: []
  Backend cannot answer context questions.

Assistant response saved as user role
  Message count and last-message logic break.

Cloud refresh overwrites local longer chat with empty cloud state
  User sees lost messages.

Regenerate calls send path
  Duplicate user messages appear.
```

Minimum backend/frontend contract:

```json
{
  "message": "latest user text",
  "history": [
    {"role": "user", "content": "hello"},
    {"role": "assistant", "content": "hi"}
  ],
  "mode": "guided_coach",
  "locale": "auto"
}
```

