# 04 — Zero-Knowledge Security Architecture

## Goal
Design a system where MindPal Presence session content is cryptographically
inaccessible to MindPal as a company — not just by policy, but by architecture.
Even a full server breach reveals nothing about session content.

---

## The Core Principle: User-Derived Keys

Session summaries (the only persistent artifact of a Presence session) are
encrypted with a key derived from the user authentication credential.

The server stores ciphertext. The server never holds the plaintext key.

```
user_password / auth_token
        |
        v
   PBKDF2 / Argon2id (100k iterations, salt = user_id_hash)
        |
        v
   AES-256-GCM encryption key  (held in browser memory only)
        |
        v
   Encrypt session summary  -->  Store ciphertext on server
```

On next login, the key is re-derived from the auth credential.
Key is never serialized, never sent to server, purged from memory on logout.

---

## WebCrypto SubtleCrypto Implementation

```typescript
// Key derivation
const keyMaterial = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(authToken),
  "PBKDF2",
  false,
  ["deriveKey"]
);

const encryptionKey = await crypto.subtle.deriveKey(
  {
    name: "PBKDF2",
    salt: new TextEncoder().encode(userIdHash),
    iterations: 100000,
    hash: "SHA-256"
  },
  keyMaterial,
  { name: "AES-GCM", length: 256 },
  false,       // non-extractable
  ["encrypt", "decrypt"]
);

// Encrypting a session summary
const iv = crypto.getRandomValues(new Uint8Array(12));
const encrypted = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  encryptionKey,
  new TextEncoder().encode(sessionSummaryJson)
);
// Store: { iv_b64, ciphertext_b64 } on server
```

The key is `non-extractable` — the browser will not allow it to be serialized
or sent anywhere, enforced at the runtime level.

---

## Session Ephemerality

### What is ephemeral (never persisted):
- Raw video frames (never leave YOLO Worker)
- Audio waveforms (discarded after diarization, within the request)
- YOLO signal vectors (held in server RAM during session, purged on close)
- Speaker voice embeddings (session-scoped, not stored)

### What is persisted (encrypted, user-controlled):
- Session summary: 1-3 paragraph text summary of what was discussed
- Session metadata: date, duration, mode (couples/solo/group), participant count
- Memory atoms derived from session (existing memory graph system)

---

## Access Control

### Who can read session data?
- Only the account owner (holds the derived key)
- Multi-person sessions: only the account that initiated the session
  (future: shared access with explicit per-person consent + key sharing protocol)

### MindPal employees:
- Zero capability to read session content (architectural, not policy)
- Access logs are available for security audit (who accessed what metadata, when)
- Metadata is not encrypted (session date, duration) — necessary for billing/support

---

## Key Rotation

On password change or re-authentication:
1. Derive old key from previous credential
2. Decrypt all stored session summaries
3. Derive new key from new credential
4. Re-encrypt all session summaries with new key
5. Old key purged from memory

This is identical to how end-to-end encrypted backup works in WhatsApp.

---

## Threat Model (Extended)

| Threat | Severity | Mitigation |
|---|---|---|
| Server DB exfil | Critical | Ciphertext only; key never on server |
| Session replay attack | High | Session tokens single-use; DTLS prevents replay |
| YOLO model poisoning | Medium | Model loaded from signed, versioned CDN bundle |
| Malicious browser extension | Medium | CSP headers; WebWorker isolation |
| Fake Presence server (MITM) | High | Certificate pinning in native app; HSTS on web |
| Social engineering (support) | Low | Zero-knowledge: support cannot access content |
| Regulatory seizure | High | Cannot hand over what we do not have |
| On-device malware | Critical | Out of scope; device security is user responsibility |

---

## Regulatory Compliance Details

### GDPR Article 25 — Data Protection by Design
The zero-knowledge architecture is the strongest possible implementation of
"data protection by design and by default." No consent withdrawal mechanism
is needed for session content because we never have it.

### Illinois BIPA
BIPA applies to "biometric identifiers" including face geometry.
Our on-device YOLO processing with no cloud transmission means we never
collect biometric identifiers as defined by BIPA. We collect derived signals
(posture category, gaze score) which are not biometric identifiers.

### EU AI Act — High Risk Classification
Camera-based emotion inference in sensitive contexts (therapy/mental health)
is likely classified as high-risk under Annex III.
Required: conformity assessment, human oversight mechanism, incident log,
accuracy/robustness documentation, transparency to users.
Action required before launch: legal review + technical conformity assessment.

---

## Open Items
- [ ] Verify SubtleCrypto non-extractable key behavior across Firefox, Safari, Chrome
- [ ] Design key recovery mechanism (what if user forgets password? Data is lost — acceptable?)
- [ ] Legal review: does derived-signal-vector constitute biometric data under BIPA?
- [ ] Implement automated key rotation on auth token refresh
- [ ] Security audit: engage third-party pen tester for WebRTC + WebCrypto implementation
