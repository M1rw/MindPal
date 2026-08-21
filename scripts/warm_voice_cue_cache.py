from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request

COMMON_CUES = ("mhm", "yeah", "aha", "right", "okay")


def main() -> int:
    parser = argparse.ArgumentParser(description="Warm MindPal V3 neutral realtime voice cues for enabled personas.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token", required=True, help="Firebase ID token; never written to disk")
    parser.add_argument("--app-check", default="")
    parser.add_argument("--personas", default="Kore,Charon", help="Comma-separated enabled personas")
    args = parser.parse_args()
    endpoint = args.base_url.rstrip("/") + "/api/voice/v3/tts"
    results: list[dict[str, object]] = []
    failed = False

    for persona in (item.strip() for item in args.personas.split(",")):
        if not persona:
            continue
        for cue in COMMON_CUES:
            first = request(endpoint, args.token, args.app_check, persona, cue)
            second = request(endpoint, args.token, args.app_check, persona, cue)
            audio = first.get("audioBase64", "")
            hit = bool(second.get("cached", False))
            ok = isinstance(audio, str) and (bool(audio) or first.get("fallback") == "non_verbal_hum") and hit
            if not ok:
                failed = True
            results.append({
                "persona": persona,
                "cue": cue,
                "warm_ok": ok,
                "cache_hit": hit,
                "fallback": first.get("fallback"),
                "durationMs": first.get("durationMs"),
            })

    print(json.dumps({"event": "tts.cache.warm", "success": not failed, "results": results}, indent=2))
    return 1 if failed else 0


def request(endpoint: str, token: str, app_check: str, persona: str, cue: str) -> dict[str, object]:
    payload = {"text": cue, "persona": persona, "emotion": "neutral", "format": "pcm16", "sampleRate": 24_000}
    headers = {"Accept": "application/json", "Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    if app_check:
        headers["X-Firebase-AppCheck"] = app_check
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        print(f"cache warm request failed for {persona}/{cue}: {exc}", file=sys.stderr)
        return {"fallback": "request_failed"}
    if not isinstance(result, dict):
        return {"fallback": "malformed_response"}
    if isinstance(result.get("audioBase64"), str) and result.get("audioBase64"):
        try:
            base64.b64decode(result["audioBase64"], validate=True)
        except (ValueError, TypeError):
            return {"fallback": "malformed_audio"}
    return result


if __name__ == "__main__":
    raise SystemExit(main())
