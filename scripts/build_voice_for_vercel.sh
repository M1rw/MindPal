#!/usr/bin/env bash
set -euo pipefail

mkdir -p frontend/voice/public/assets
rm -f frontend/voice/public/assets/voice-auth.bundle.js
cp frontend/dist/voice-auth.bundle.js frontend/voice/public/assets/voice-auth.bundle.js
npm --prefix frontend/voice install
npm --prefix frontend/voice run build
# Rebuild the production controller as a self-contained module.
VOICE_RUNTIME_ONLY=1 npm --prefix frontend/voice run build
mkdir -p frontend/voice/assets
cp -R frontend/voice/dist/assets/. frontend/voice/assets/
