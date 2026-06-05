# Vercel Deployment Configuration Guide

## Overview

This repository is configured for Vercel serverless deployment with a FastAPI backend and static frontend assets.

## Key Configuration Files

### `vercel.json`
- **buildCommand**: Installs Python dependencies from requirements.txt
- **functions**: Defines the serverless function configuration (api/index.py)
- **routes**: Maps all requests to the FastAPI entry point
- **environment**: Sets production-safe environment variables

### `api/index.py`
- Root-level Vercel Functions entry point
- Initializes Vercel-specific environment configuration
- Exports the FastAPI application instance

### `vercel_config.py`
- Advanced environment configuration for serverless
- Handles frontend path resolution
- Sets Python-specific optimizations

### `.vercelignore`
- Optimizes build size by excluding unnecessary files
- Reduces deployment time and function size

## Deployment Architecture

```
User Request
    ↓
Vercel Edge Network
    ↓
Vercel Functions Router (vercel.json routes)
    ↓
api/index.py (FastAPI entry point)
    ↓
Backend Routes (/api/*)
Static Files (/app/*)
Frontend (/ui)
API Docs (/docs)
```

## Environment Variables

Set these in Vercel Project Settings → Environment Variables:

```
ENVIRONMENT=production
DEBUG=false
ENABLE_DOCS=false
ENABLE_HSTS=true
FIREBASE_USE_APPLICATION_DEFAULT=false
PYTHONUNBUFFERED=1
```

Add any additional secrets needed by your backend:
- Firebase credentials
- API provider keys
- Authentication tokens

## Pre-Deployment Checklist

- [ ] All environment variables configured in Vercel
- [ ] Requirements.txt dependencies are compatible with Python 3.12
- [ ] Firebase service account configured (if needed)
- [ ] Frontend static files are in place
- [ ] No hardcoded local paths in code
- [ ] Python imports use absolute paths (e.g., `from backend.main import app`)

## Troubleshooting

### Build Failures
1. Check build logs: Vercel Dashboard → Project → Deployments → Failed Build → Logs
2. Verify requirements.txt has no platform-specific packages
3. Ensure Python 3.12 is compatible with all dependencies

### Runtime Errors
1. Check Function logs: Vercel Dashboard → Project → Functions
2. Verify environment variables are set correctly
3. Check that api/index.py can import backend.main

### Static Files Not Serving
1. Verify frontend directory structure exists
2. Check vercel.json routes include /app/* pattern
3. Ensure index.html is in the frontend directory

## Advanced: Memory and Timeout

Current configuration in vercel.json:
- **Memory**: 3008 MB (suitable for FastAPI + Firebase operations)
- **MaxDuration**: 30 seconds (suitable for most API operations)

Adjust if needed based on workload:
- CPU-intensive operations may need timeout increase
- Large file uploads may need memory increase

## Monitoring

After deployment:
1. Monitor Function execution time in Vercel Dashboard
2. Review error logs for patterns
3. Track cold starts and performance metrics
4. Use `/api/health` endpoint for uptime monitoring

## Local Testing

Before deploying to Vercel:

```bash
# Install dependencies
pip install -r requirements.txt

# Run locally
python -m uvicorn backend.main:app --reload

# Test the app
curl http://localhost:8000/api/health
```

## Documentation

- FastAPI Docs: https://your-domain.vercel.app/docs
- API Health Check: https://your-domain.vercel.app/api/health
- Frontend UI: https://your-domain.vercel.app/ui
