# Vercel build hotfix

## Root cause

The previous release had two independent CI portability defects:

1. `vercel.json` repeated both dependency installation steps inside `buildCommand` even though Vercel installs dependencies before the build. The second `npm ci` triggered npm's `Exit handler never called!` failure.
2. `package-lock.json` contained 190 `resolved` tarball URLs for an OpenAI-internal Artifactory registry. Those URLs are not portable to Vercel.

## Fix

- `buildCommand` is now only `npm run build`.
- Node is pinned to `20.x` and npm to `10.x`.
- All lockfile tarballs resolve from `https://registry.npmjs.org/`.
- `.npmrc` pins the public npm registry.
- `scripts/verify_lockfile_registry.mjs` fails the build if an internal or unapproved registry URL is committed again.

## Vercel settings

Leave **Install Command** empty so Vercel performs automatic dependency installation.
Set **Build Command** to `npm run build`, or disable the dashboard override so `vercel.json` is used.
Set **Node.js Version** to `20.x`; `package.json` also enforces it.

Then redeploy with **Clear build cache** once, because the failed deployment may have cached the previous npm state.
