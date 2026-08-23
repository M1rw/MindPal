#!/usr/bin/env bash
set -euo pipefail

mkdir -p voice/public/assets
rm -f voice/public/assets/voice-auth.bundle.js
cp frontend/dist/voice-auth.bundle.js voice/public/assets/voice-auth.bundle.js
npm --prefix voice ci
npm --prefix voice run build
# Rebuild the production controller as a self-contained module.
VOICE_RUNTIME_ONLY=1 npm --prefix voice run build
rm -rf frontend/voice frontend/voice-v3
mkdir -p frontend/voice
cp -R voice/dist/. frontend/voice/
