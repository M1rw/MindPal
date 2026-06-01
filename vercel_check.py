#!/usr/bin/env python3
"""
Pre-deployment verification and optimization script for Vercel.

This script validates that the project is ready for Vercel deployment
and performs necessary pre-flight checks.
"""

from __future__ import annotations

import sys
from pathlib import Path


def check_required_files() -> bool:
    """Verify all required files exist for Vercel deployment."""
    print("\n📋 Checking required files...")
    required = [
        "vercel.json",
        "requirements.txt",
        "api/index.py",
        "vercel_config.py",
        "backend/main.py",
        "frontend",
    ]
    
    root = Path(__file__).parent
    all_present = True
    
    for file in required:
        path = root / file
        exists = path.exists()
        status = "✓" if exists else "✗"
        print(f"  {status} {file}")
        if not exists:
            all_present = False
    
    return all_present


def check_vercel_json() -> bool:
    """Validate vercel.json configuration."""
    print("\n⚙️  Validating vercel.json...")
    try:
        import json
        root = Path(__file__).parent
        with open(root / "vercel.json") as f:
            config = json.load(f)
        
        required_keys = ["version", "env", "functions", "routes"]
        missing = [k for k in required_keys if k not in config]
        
        if missing:
            print(f"  ✗ Missing required keys: {missing}")
            return False
        
        if config.get("version") != 2:
            print(f"  ✗ Invalid version: {config.get('version')} (expected 2)")
            return False
        
        print("  ✓ vercel.json is valid")
        return True
    except Exception as e:
        print(f"  ✗ Error validating vercel.json: {e}")
        return False


def check_python_compatibility() -> bool:
    """Check Python version and dependency compatibility."""
    print("\n🐍 Checking Python compatibility...")
    
    current_version = sys.version_info
    required_version = (3, 12)
    
    if current_version >= required_version:
        print(f"  ✓ Python {current_version.major}.{current_version.minor} (required 3.12+)")
        return True
    else:
        print(f"  ⚠ Python {current_version.major}.{current_version.minor} < 3.12 (may cause issues)")
        return False


def check_imports() -> bool:
    """Verify critical imports work."""
    print("\n📦 Checking critical imports...")
    
    try:
        from backend.main import app
        print("  ✓ backend.main:app imports successfully")
    except ImportError as e:
        print(f"  ✗ Failed to import backend.main:app: {e}")
        return False
    
    try:
        import api.index
        print("  ✓ api.index imports successfully")
    except ImportError as e:
        print(f"  ✗ Failed to import api.index: {e}")
        return False
    
    return True


def check_environment_variables() -> bool:
    """Verify environment variables are properly configured."""
    print("\n🔧 Checking environment configuration...")
    
    required_env = [
        "ENVIRONMENT",
        "DEBUG",
        "ENABLE_DOCS",
        "ENABLE_HSTS",
    ]
    
    import json
    root = Path(__file__).parent
    with open(root / "vercel.json") as f:
        config = json.load(f)
    
    env_vars = config.get("env", {})
    missing = [k for k in required_env if k not in env_vars]
    
    if missing:
        print(f"  ⚠ Missing environment variables in vercel.json: {missing}")
        return False
    
    print(f"  ✓ All required environment variables configured")
    return True


def main() -> int:
    """Run all pre-deployment checks."""
    print("\n" + "="*50)
    print("🚀 Vercel Pre-Deployment Verification")
    print("="*50)
    
    checks = [
        ("Required Files", check_required_files),
        ("Configuration Files", check_vercel_json),
        ("Python Compatibility", check_python_compatibility),
        ("Critical Imports", check_imports),
        ("Environment Setup", check_environment_variables),
    ]
    
    results = []
    for name, check_func in checks:
        try:
            result = check_func()
            results.append(result)
        except Exception as e:
            print(f"\n❌ {name}: {e}")
            results.append(False)
    
    print("\n" + "="*50)
    if all(results):
        print("✅ All checks passed! Ready for deployment.")
        print("="*50 + "\n")
        return 0
    else:
        failed = sum(1 for r in results if not r)
        print(f"❌ {failed}/{len(results)} checks failed. Please fix issues above.")
        print("="*50 + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
