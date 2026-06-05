# Release And Deploy Flow

Release goal: never deploy a change that silently breaks voice, chat sync, auth, RAG, memory, or static serving.

Recommended branch flow:

```txt
main
  stable deploy branch

feature branch
  one subsystem at a time
```

Before coding:

```txt
git status
confirm scope
identify forbidden files/systems
run targeted tests if risky
```

Before commit:

```powershell
git status --short
python -m pytest
python -m compileall backend tests -q
```

For frontend-touching changes:

```powershell
node --check frontend/js/app.js
node --check frontend/js/api.js
node --check frontend/js/voice.js
```

For RAG changes:

```powershell
python -m pytest tests/test_rag_clinical_frameworks.py -q
```

For deployment:

```powershell
git push origin main
```

Post-deploy smoke:

```powershell
curl.exe "https://<deployment-host>/api/health"
curl.exe "https://<deployment-host>/api/rag/health"
```

Manual smoke:

```txt
open app
login
send message
refresh
verify chat remains
test one voice recording
test one Arabic relationship prompt
```

Do not combine:

```txt
voice changes + auth changes
RAG changes + memory schema changes
static serving changes + provider changes
Cloudflare provider changes + deploy config changes
```

Good commit examples:

```txt
add clinical framework RAG corpus
add durable structured memory
add debug panel for chat pipeline
document release regression checklist
```

Bad commit examples:

```txt
fix everything
update app
final changes
voice auth rag deploy memory
```

