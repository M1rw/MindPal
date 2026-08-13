# Deployment Investigation Notes

## Observed status

The production deployment for `mindpal-demo` is **Ready** and serves commit `3c9f6c7` (`feat: enhance memory graph synchronization and voice processing`) from `main`, deployed on July 11.

The local checkout is also commit `3c9f6c7` and `python3 scripts/verify_prebuilt_frontend.py` completes successfully with: `Prebuilt frontend verified: 36 inputs, 3 immutable outputs.`

Several more recent preview deployments for Dependabot branches are marked **Error**, including preview #17 for `dependabot/npm_and_yarn/nanoid-3.3.18` (two days ago), #16 for `dependabot/npm_and_yarn/dompurify-3.4.13`, and #15 for `dependabot/npm_and_yarn/postcss-8.5.25`.

## Preliminary hypothesis

The reported verifier failure is not reproducible on current `main`; it likely affects a preview branch where a dependency manifest or frontend source file changed without regenerating and committing the immutable prebuilt assets and `frontend/prebuilt-assets.manifest.json`. The detailed preview build log is still required to confirm the exact divergence.

## Configuration observed

Vercel executes `python scripts/verify_prebuilt_frontend.py` as its build command. Its project is linked to `M1rw/MindPal`, and the production deployment is healthy.

The `.vercelignore` excludes hidden files, documentation, local artifacts, and Markdown files, but does not visibly exclude the verifier’s frontend source inputs, prebuilt outputs, or manifest.

## Confirmed root cause

Vercel preview deployment `CbkKyXqsJbccf72Wfeyv2eYSyWTJ` for commit `321a4a7` (`dependabot/npm_and_yarn/nanoid-3.3.18`) failed at `python scripts/verify_prebuilt_frontend.py`. Its detailed error is:

```text
Prebuilt frontend verification failed: frontend source changed without rebuilding artifacts; run `npm ci && npm run build` and commit the generated files
```

The failure was reproduced in an isolated worktree at the same commit. That commit changes only `package-lock.json`; however, the verifier intentionally includes `package-lock.json` in the manifest source digest. The commit therefore invalidates the prebuilt frontend manifest even though the JavaScript source and generated bundles did not otherwise change. Current `main` passes verification and its production deployment is ready.

## Live application observation

The product is a chat-first, wellness-oriented companion with a prominent text input, selectable response mode/model, voice input, progress access, and profile/settings access. Its primary memory controls are currently accessed indirectly through Settings, rather than through a dedicated knowledge workspace. The review used the owner’s signed-in session only for interface observation; no messages, account data, or settings were changed.

## Current workflow model

1. The user writes or speaks during a chat-first session and selects a preferred conversational mode.
2. The frontend sends the latest message plus current chat context to the backend.
3. The backend loads active memory atoms, determines safety and response routing, builds a prompt using the relevant memory/context, and streams a response.
4. A post-response process extracts memory candidates, merges the delta into the durable memory graph, persists/synchronizes it, and updates the client-side inspector.
5. The user can review, pin, edit, delete, or clear category-based memory items through Settings. Raw chat history and durable memory remain deliberately separate.
