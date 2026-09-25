"""Web Push, the private way: an empty push, signed with VAPID.

The push carries no payload. It only wakes MindPal's service worker, which
shows a fixed, gentle line ("A quick check-in is waiting for you") in the
phone's language; the actual question is in the app when they open it. So no
words from anyone's memory ever pass through Google's, Apple's or Mozilla's
push servers, and no payload encryption (RFC 8291) is needed: only the VAPID
signature (RFC 8292), which `cryptography` provides.

Endpoints come from browsers, so the server only ever posts to known push
services: anything else is refused at subscribe time and again at send time.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Tuple
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

# The push services browsers actually use: Chrome/Edge/Android (FCM), Firefox,
# Safari/iOS (Apple), and Windows.
_PUSH_HOSTS = (
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
    ".push.apple.com",
    ".notify.windows.com",
)
TTL_SECONDS = 12 * 3600
TIMEOUT_S = 8.0


class PushGone(Exception):
    """The subscription no longer exists (uninstalled, permission revoked): forget it."""


class PushFailed(Exception):
    """The push service refused or failed; try again another day."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def allowed_endpoint(endpoint: str) -> bool:
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.port not in (None, 443):
        return False
    return any(host == h or (h.startswith(".") and host.endswith(h)) for h in _PUSH_HOSTS)


def _private_key(private_b64: str) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(_b64url_decode(private_b64), "big"), ec.SECP256R1())


def public_key_for(private_b64: str) -> str:
    """The applicationServerKey browsers subscribe with (uncompressed P-256 point)."""
    point = _private_key(private_b64).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return _b64url(point)


def generate_keys() -> Tuple[str, str]:
    """(private, public) VAPID keys, base64url, for the VAPID_* settings."""
    key = ec.generate_private_key(ec.SECP256R1())
    private_b64 = _b64url(key.private_numbers().private_value.to_bytes(32, "big"))
    return private_b64, public_key_for(private_b64)


def vapid_authorization(endpoint: str, private_b64: str, subject: str, *, now: float | None = None) -> str:
    parsed = urlparse(endpoint)
    audience = f"{parsed.scheme}://{parsed.netloc}"
    issued = int(now if now is not None else time.time())
    header = _b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({"aud": audience, "exp": issued + TTL_SECONDS, "sub": subject}, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode("ascii")
    der = _private_key(private_b64).sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    signature = _b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"vapid t={header}.{claims}.{signature}, k={public_key_for(private_b64)}"


def send_empty_push(endpoint: str, private_b64: str, subject: str, *, client: httpx.Client | None = None) -> None:
    """Wake the service worker at `endpoint`. Raises PushGone or PushFailed."""
    if not allowed_endpoint(endpoint):
        raise PushGone("not a known push service")
    headers = {
        "TTL": str(TTL_SECONDS),
        "Urgency": "normal",
        "Authorization": vapid_authorization(endpoint, private_b64, subject),
        "Content-Length": "0",
    }
    try:
        if client is not None:
            response = client.post(endpoint, headers=headers, content=b"", timeout=TIMEOUT_S)
        else:
            response = httpx.post(endpoint, headers=headers, content=b"", timeout=TIMEOUT_S)
    except httpx.HTTPError as exc:
        raise PushFailed(type(exc).__name__) from exc
    if response.status_code in (404, 410):
        raise PushGone(str(response.status_code))
    if response.status_code >= 400:
        raise PushFailed(f"{response.status_code}: {response.text[:120]}")
