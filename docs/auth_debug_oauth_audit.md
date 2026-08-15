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

## Pre-repair provider launch result

After the OAuth secret update but before the user-gesture repair, clicking **Continue with Google** failed immediately in MindPal before Google account selection. The visible diagnostic identified the stage as **Google provider window**. This demonstrated that the browser gesture had not reached a usable Firebase popup launch, even though the OAuth client settings were valid.

The direct-popup user-gesture repair was then deployed in commit `9d8ed92`. Production was refreshed afterward and is ready for the final verification.

## Direct-popup repair verification checkpoint

After the `9d8ed92` deployment, the refreshed production page and Account panel loaded normally in Local Mode. The Google provider has not yet been launched from this repaired build at this checkpoint.

## Official helper-free sign-in fallback

Firebase documents an advanced Google sign-in option in which an application obtains a Google ID token itself and exchanges it with Firebase using `GoogleAuthProvider.credential(idToken)` and `signInWithCredential`. This bypasses Firebase's `signInWithPopup` and `signInWithRedirect` helper flow.

Google Identity Services documents a browser token model in which `google.accounts.oauth2.initTokenClient()` is initialized with the web client ID, and a user gesture calls `requestAccessToken()` to open Google account selection and consent.

Sources:

- Firebase Google sign-in guide: https://firebase.google.com/docs/auth/web/google-signin
- Google Identity Services token model: https://developers.google.com/identity/oauth2/web/guides/use-token-model
- Firebase redirect best-practices, Option 5: https://firebase.google.com/docs/auth/web/redirect-best-practices

## Google Identity Services deployment checkpoint

Commit `48e6c65` deployed successfully. It replaces Google’s Firebase popup helper with a Google Identity Services token request followed by a Firebase `signInWithCredential` exchange. The production page was refreshed and is ready for the final provider test.

## Final verification setup

The refreshed Google Identity build reached MindPal’s Account panel successfully and is in expected Local Mode before the user initiates sign-in. No Google account has been selected or consent granted at this point.

## Readiness diagnosis and repair

The live test of commit `48e6c65` reached the native sign-in modal but returned the safe code `google_identity_not_ready`; the Google Identity Services library was not yet present when the Google button was pressed. The repair preloads `https://accounts.google.com/gsi/client` in the document head and makes the application loader reuse that same script and its load/error events. This maintains a synchronous user-click token request once the library is ready, while eliminating the timing race caused by injecting the provider library only during application initialization.
