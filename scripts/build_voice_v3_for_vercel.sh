#!/usr/bin/env bash
set -euo pipefail

mkdir -p voice-v3/public/assets
rm -f voice-v3/public/voice-v3-auth.bundle.js
cp frontend/dist/voice-v3-auth.bundle.js voice-v3/public/assets/voice-v3-auth.bundle.js
npm --prefix voice-v3 ci
npm --prefix voice-v3 run build
rm -rf frontend/voice-v3
mkdir -p frontend/voice-v3
cp -R voice-v3/dist/. frontend/voice-v3/
