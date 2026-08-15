# Google OAuth Client Audit — 2026-08-15

## Client reviewed

- **Project:** `mindpal-official-0`
- **OAuth client:** `234733155455-j0cfkt4hgq4esqaauvro1jmgq81vgcq0.apps.googleusercontent.com`
- **Client status:** Enabled
- **Client type:** Web application, auto-created by Google Service

## Verified browser origins

The client currently permits all required browser origins:

| Origin | Present |
| --- | --- |
| `http://localhost` | Yes |
| `http://localhost:5000` | Yes |
| `https://mindpal-official-0.firebaseapp.com` | Yes |
| `https://mindpal-demo.vercel.app` | Yes |

## Verified redirect URI

The Firebase-hosted callback required by the deployed popup configuration is present:

```text
https://mindpal-official-0.firebaseapp.com/__/auth/handler
```

The console reports two redirect URI rows, but the second value was not visible in the captured viewport. The custom MindPal callback URI was previously added by the user and is not required by the current Firebase-hosted popup configuration.

## Finding

The visible OAuth origin and Firebase-hosted redirect configuration are correct. Since the production client now fails at the **Google provider window** after this configuration is reached, the most probable remaining Firebase-side mismatch is the OAuth client secret stored in Firebase Authentication's Google provider configuration. Firebase needs the current secret for the same enabled OAuth client in order to exchange the Google authorization result.

No OAuth secret, callback code, or authorization URL was recorded in this audit.

## Post-secret-update production test state

- The production MindPal page loaded successfully in the connected browser after the user updated Firebase's Google provider secret.
- The app was in Local Mode before the new sign-in test, as expected for a fresh session.
- Profile settings opened successfully and the Account panel is ready for the Google provider launch.

No Google account was selected and no consent was submitted at this checkpoint.
