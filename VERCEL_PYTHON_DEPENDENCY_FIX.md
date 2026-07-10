# Vercel mixed Python + frontend dependency fix

## Failure

The deployment imported `backend.main` without FastAPI installed because `vercel.json` supplied a custom npm-only `installCommand`. That override replaced Vercel's normal install phase for this mixed Python/Node project.

## Final configuration

- No `installCommand` in `vercel.json`.
- `requirements.txt` remains at the repository root, so the Python runtime installs the locked backend dependencies.
- `buildCommand` remains `npm run build`.
- `tailwindcss` and `esbuild` are regular npm dependencies, so they are installed even when the build environment omits dev dependencies.
- `package-lock.json` resolves exclusively through the public npm registry.

## Vercel dashboard

Disable any custom Install Command override. Leave Install Command at the framework default. The Build Command may also use the repository configuration (`npm run build`). The project Root Directory must be the directory containing `requirements.txt`, `package.json`, `pyproject.toml`, and `vercel.json`.

After committing this fix, redeploy once with the build cache cleared.
