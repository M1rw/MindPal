# Vercel prebuilt frontend deployment

MindPal no longer compiles Tailwind or JavaScript inside Vercel.

The frontend is built during local/CI release creation and these immutable outputs are committed:

- `frontend/css/tailwind.generated.css`
- `frontend/dist/lucide.bundle.js`
- `frontend/dist/app.bundle.js`
- `frontend/prebuilt-assets.manifest.json`

Vercel performs two deterministic operations:

```text
Install: python -m pip install --disable-pip-version-check --no-input -r requirements.txt
Build:   python scripts/verify_prebuilt_frontend.py
```

The verifier uses only the Python standard library. It validates source fingerprints, output sizes, and SHA-256 hashes. A stale or missing frontend build fails deployment with an actionable message.

## Local frontend changes

After changing frontend source:

```powershell
npm ci
npm run build
python scripts/verify_prebuilt_frontend.py
```

Commit the generated CSS, bundles, and manifest together with the source change.

## Vercel dashboard

Set the Root Directory to the repository root. Disable dashboard overrides for Install Command, Build Command, and Output Directory because `vercel.json` is authoritative. Redeploy with the build cache cleared once after applying this migration.
