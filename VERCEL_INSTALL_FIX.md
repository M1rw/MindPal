# Vercel install-stage fix

The deployment is a mixed FastAPI + Node frontend build. Vercel may use the Python framework install path and then execute the configured Node build without installing frontend devDependencies.

The release now declares:

```json
"installCommand": "npm ci --include=dev --no-audit --no-fund",
"buildCommand": "npm run build"
```

`--include=dev` is intentional because Tailwind CSS and esbuild are build-time dependencies. The Python runtime continues to install `requirements.txt`/`requirements.lock` for the Python function independently.

In Vercel Project Settings, remove any dashboard Install Command or Build Command override that conflicts with `vercel.json`. Clear the build cache once and redeploy.
