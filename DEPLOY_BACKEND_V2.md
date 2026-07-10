# Deploy MindPal Backend V2

## 1. Back up and apply

From PowerShell:

```powershell
Expand-Archive .\MindPal_backend_v2_release.zip -DestinationPath .\MindPal_Backend_V2
Set-ExecutionPolicy -Scope Process Bypass
.\MindPal_Backend_V2\MindPal_backend_v2\Apply-Backend-V2.ps1 -TargetRoot 'E:\Synthos\MindPal'
```

The script backs up managed source paths, preserves `.env`, credentials, logs, and runtime data, reuses the local virtual environment when present, replaces managed code deterministically, installs locked dependencies, builds the frontend, and runs the release gate. Failed verification triggers source rollback.

## 2. Configure production

Copy `.env.production.example` to `.env` and replace every placeholder. Do not commit `.env` or service-account JSON. The server and browser Firebase project IDs must match.

For Vercel, add the values as encrypted project environment variables. `FIREBASE_CREDENTIALS_JSON` must be a single valid JSON value. Keep the Root Directory at the repository directory containing `requirements.txt` and `package.json`; disable any custom Install Command override. Vercel installs Python dependencies from the root `requirements.txt`, installs the regular npm dependencies, and runs `npm run build`.

## 3. Firebase App Check

Register the MindPal web app with App Check using reCAPTCHA Enterprise. Put the public site key in `FIREBASE_APPCHECK_SITE_KEY`, set `REQUIRE_FIREBASE_APP_CHECK=true`, deploy, verify token acceptance, then enable enforcement in Firebase. The frontend automatically refreshes App Check tokens and sends `X-Firebase-AppCheck` on authenticated calls.

## 4. Firebase operational controls

- Enable ID-token revocation checks.
- Deny direct Firestore client access unless a specific client feature requires it.
- Create TTL policies for:
  - `rate_limit_buckets.expires_at`
  - `idempotency_records.expires_at`
- Assign `mindpal_admin=true` only through a trusted administrative script.

## 5. Verify

```powershell
.\Verify-Backend-V2.ps1 -ProjectRoot 'E:\Synthos\MindPal'
```

Optional network-dependent vulnerability lookup:

```powershell
.\Verify-Backend-V2.ps1 -ProjectRoot 'E:\Synthos\MindPal' -OnlineAudit
```

Smoke endpoints:

```text
GET /api/health
GET /api/health/live
GET /api/health/ready
```

Detailed diagnostics require a verified admin identity.

## 6. Roll back

The apply script prints the backup path. Manual rollback:

```powershell
.\Rollback-Backend-V2.ps1 -TargetRoot 'E:\Synthos\MindPal' -BackupRoot 'E:\Synthos\MindPal_backups\backend-v2-YYYYMMDD-HHMMSS'
```

## Vercel build model

Do not run `npm run build` on Vercel. Production assets are prebuilt and committed.

The authoritative `vercel.json` commands are:

```text
Install Command: python -m pip install --disable-pip-version-check --no-input -r requirements.txt
Build Command:   python scripts/verify_prebuilt_frontend.py
Framework:       FastAPI
Output Directory: unset
```

Disable matching dashboard overrides, then clear the Vercel build cache for the first deployment after this change.
