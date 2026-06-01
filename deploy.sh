#!/usr/bin/env bash
# Vercel Deployment Quick Start

# Step 1: Ensure all changes are committed
echo "Committing deployment fixes..."
git add -A
git commit -m "fix: resolve Vercel deployment issues and code import errors

- Fixed missing Vercel serverless configuration in vercel.json
- Added api/index.py as Vercel Functions entry point
- Created .vercelignore for build optimization
- Added vercel_config.py for serverless environment setup
- Fixed RagError (should be RAGError) import in rag_service.py
- Fixed ValidationError (should be ValidationAppError) in tts_service.py
- Updated backend/core/__init__.py error exports
- Added comprehensive deployment guides

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

# Step 2: Push to remote
echo "Pushing to remote..."
git push origin main

# Step 3: Deploy to Vercel
echo "Deploying to Vercel..."
vercel deploy --prod

echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Monitor build at: Vercel Dashboard → Deployments"
echo "2. Verify health: curl https://your-domain.vercel.app/api/health"
echo "3. Check logs: Vercel Dashboard → Functions → Logs"
