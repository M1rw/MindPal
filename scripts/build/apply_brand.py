#!/usr/bin/env python3
"""
scripts/build/apply_brand.py -- MindPal Design Token Pipeline
=======================================================
Reads brand.json (single source of truth) and generates:

  1. frontend/index.html         -- replaces the <!-- BRAND:START/END --> block
  2. frontend/site.webmanifest   -- fully regenerated from tokens
  3. frontend/css/brand-tokens.css -- CSS custom properties for runtime use

Usage:
  python scripts/build/apply_brand.py            # apply tokens (mutates files)
  python scripts/build/apply_brand.py --check    # dry-run: exits 1 if any file is stale
  python scripts/build/apply_brand.py --verbose  # print diff of each change

This script has ZERO external dependencies -- stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
BRAND_FILE = ROOT / "brand.json"
INDEX_HTML = ROOT / "frontend" / "index.html"
# Swaps the non-blocking font stylesheet in once it has loaded.
FONT_ONLOAD = "this.media='all'"
WEBMANIFEST = ROOT / "frontend" / "site.webmanifest"
BRAND_CSS = ROOT / "frontend" / "css" / "brand-tokens.css"

BRAND_START = "<!-- BRAND:START -->"
BRAND_END = "<!-- BRAND:END -->"


# ---------------------------------------------------------------------------
# Load tokens
# ---------------------------------------------------------------------------
def load_brand() -> dict:
    if not BRAND_FILE.exists():
        sys.exit("[apply_brand] ERROR: brand.json not found. Cannot continue.")
    with BRAND_FILE.open(encoding="utf-8") as f:
        data = json.load(f)
    # Strip comment keys (keys starting with _)
    return {k: v for k, v in data.items() if not k.startswith("_")}


# ---------------------------------------------------------------------------
# Generator: index.html BRAND block
# ---------------------------------------------------------------------------
def _build_html_brand_block(b: dict) -> str:
    ident = b["identity"]
    colors = b["colors"]
    assets = b["assets"]
    social = b["social"]
    typ = b["typography"]

    name = ident["name"]
    tagline = ident["tagline"]
    description = ident["description"]
    canonical = ident["canonical_url"].rstrip("/")
    locale = ident["locale"]
    robots = ident["robots"]
    og_image_abs = canonical + assets["og_image"]
    og_w = assets["og_image_width"]
    og_h = assets["og_image_height"]
    em_dash = "\u2014"
    title = name + " " + em_dash + " " + tagline
    tc = social["twitter_card"]
    tl = colors["theme_light"]
    td = colors["theme_dark"]
    fav = assets["favicon_ico"]
    i16  = assets.get("icon_16",  "")
    i32  = assets["icon_32"]
    i128 = assets.get("icon_128", "")
    i192 = assets["icon_192"]
    i256 = assets.get("icon_256", "")
    i512 = assets["icon_512"]
    ati  = assets["apple_touch_icon"]
    furl = typ["font_url"]

    I = "    "  # 4-space indent to match surrounding HTML

    rows = [
        BRAND_START,
        I + "<!-- Google Fonts -->",
        I + '<link rel="preconnect" href="https://fonts.googleapis.com">',
        I + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        # Not render-blocking: the page paints at once in the system font and
        # switches to the brand font when it arrives (a blocking stylesheet from
        # another origin held the first paint back about a second on phones).
        I + '<link rel="preload" as="style" href="' + furl + '">',
        I + '<link rel="stylesheet" href="' + furl + '" media="print" onload="' + FONT_ONLOAD + '">',
        I + '<noscript><link rel="stylesheet" href="' + furl + '"></noscript>',
        "",
        I + "<!-- SEO core -->",
        I + "<title>" + title + "</title>",
        I + '<meta name="description" content="' + description + '">',
        I + '<meta name="robots" content="' + robots + '">',
        I + '<link rel="canonical" href="' + canonical + '/">',
        "",
        I + "<!-- PWA / App identity -->",
        I + '<meta name="application-name" content="' + name + '">',
        I + '<meta name="apple-mobile-web-app-title" content="' + name + '">',
        I + '<meta name="apple-mobile-web-app-capable" content="yes">',
        I + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
        I + '<meta name="mobile-web-app-capable" content="yes">',
        I + '<meta name="format-detection" content="telephone=no">',
        "",
        I + "<!-- Theme color (browser chrome) -->",
        I + '<meta name="theme-color" content="' + tl + '" media="(prefers-color-scheme: light)">',
        I + '<meta name="theme-color" content="' + td + '" media="(prefers-color-scheme: dark)">',
        "",
        I + "<!-- Icons & manifest -->",
        I + '<link rel="manifest" href="/site.webmanifest">',
        I + '<link rel="icon" href="' + fav + '" sizes="any">',
        *(([I + '<link rel="icon" href="' + i16 + '" type="image/png" sizes="16x16">']) if i16 else []),
        I + '<link rel="icon" href="' + i32 + '" type="image/png" sizes="32x32">',
        *(([I + '<link rel="icon" href="' + i128 + '" type="image/png" sizes="128x128">']) if i128 else []),
        I + '<link rel="apple-touch-icon" href="' + ati + '">',
        "",
        I + "<!-- Open Graph -->",
        I + '<meta property="og:type" content="website">',
        I + '<meta property="og:site_name" content="' + name + '">',
        I + '<meta property="og:title" content="' + title + '">',
        I + '<meta property="og:description" content="' + description + '">',
        I + '<meta property="og:url" content="' + canonical + '/">',
        I + '<meta property="og:image" content="' + og_image_abs + '">',
        I + '<meta property="og:image:secure_url" content="' + og_image_abs + '">',
        I + '<meta property="og:image:type" content="image/png">',
        I + '<meta property="og:image:width" content="' + str(og_w) + '">',
        I + '<meta property="og:image:height" content="' + str(og_h) + '">',
        I + '<meta property="og:image:alt" content="' + title + '">',
        I + '<meta property="og:locale" content="' + locale + '">',
        "",
        I + "<!-- Twitter / X Card -->",
        I + '<meta name="twitter:card" content="' + tc + '">',
        I + '<meta name="twitter:title" content="' + title + '">',
        I + '<meta name="twitter:description" content="' + description + '">',
        I + '<meta name="twitter:image" content="' + og_image_abs + '">',
        I + '<meta name="twitter:image:alt" content="' + title + '">',
        I + BRAND_END,
    ]
    return "\n".join(rows)


def apply_index_html(b: dict, *, check: bool = False, verbose: bool = False) -> bool:
    """Replace the BRAND:START...BRAND:END block in index.html."""
    raw = INDEX_HTML.read_text(encoding="utf-8")

    pattern = re.compile(
        r"[ \t]*" + re.escape(BRAND_START) + r".*?" + re.escape(BRAND_END),
        re.DOTALL,
    )

    if not pattern.search(raw):
        sys.exit(
            "[apply_brand] ERROR: sentinel comments not found in index.html.\n"
            "  Add '<!-- BRAND:START -->' ... '<!-- BRAND:END -->' to mark the brand block."
        )

    new_block = _build_html_brand_block(b)
    new_raw = pattern.sub(new_block, raw)

    if new_raw == raw:
        _log(verbose, "  index.html -- no changes")
        return False

    if verbose:
        _print_diff("index.html", raw, new_raw)

    if not check:
        INDEX_HTML.write_text(new_raw, encoding="utf-8")
        print("[apply_brand] [OK] index.html updated")
    return True


# ---------------------------------------------------------------------------
# Generator: site.webmanifest
# ---------------------------------------------------------------------------
def _build_manifest(b: dict) -> dict:
    ident = b["identity"]
    colors = b["colors"]
    assets = b["assets"]
    pwa = b["pwa"]
    return {
        # A stable id keeps the installed app the same app if start_url changes.
        "id": pwa["start_url"],
        "name": ident["name"],
        "short_name": ident["short_name"],
        "description": ident["description"],
        "start_url": pwa["start_url"],
        "scope": pwa["scope"],
        "display": pwa["display"],
        # The app opens dark by default: a light splash flashed white before
        # the first paint, and a brand-blue title bar clashed with the canvas.
        "background_color": colors["background_dark"],
        "theme_color": colors["theme_dark"],
        "orientation": pwa["orientation"],
        "icons": [
            {"src": assets.get("icon_128", assets["icon_192"]), "sizes": "128x128", "type": "image/png", "purpose": "any"},
            {"src": assets["icon_192"],  "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": assets.get("icon_256", assets["icon_512"]), "sizes": "256x256", "type": "image/png", "purpose": "any"},
            {"src": assets["icon_512"],  "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    }


def apply_webmanifest(b: dict, *, check: bool = False, verbose: bool = False) -> bool:
    new_content = json.dumps(_build_manifest(b), indent=2, ensure_ascii=False) + "\n"
    old_content = WEBMANIFEST.read_text(encoding="utf-8") if WEBMANIFEST.exists() else ""

    if new_content == old_content:
        _log(verbose, "  site.webmanifest -- no changes")
        return False

    if verbose:
        _print_diff("site.webmanifest", old_content, new_content)

    if not check:
        WEBMANIFEST.write_text(new_content, encoding="utf-8")
        print("[apply_brand] [OK] site.webmanifest updated")
    return True


# ---------------------------------------------------------------------------
# Generator: brand-tokens.css
# ---------------------------------------------------------------------------
def _build_css_tokens(b: dict) -> str:
    colors = b["colors"]
    typ = b["typography"]
    ident = b["identity"]

    rows = [
        "/*",
        " * brand-tokens.css -- AUTO-GENERATED by scripts/build/apply_brand.py",
        " * Source of truth: brand.json",
        " * DO NOT EDIT MANUALLY -- run `npm run brand` to regenerate.",
        " */",
        "",
        ":root {",
        "  /* Brand identity */",
        '  --brand-name:                  "' + ident["name"] + '";',
        "",
        "  /* Core Brand Colors */",
        "  --color-brand-primary:         " + colors["primary"] + ";",
        "  --brand-primary:               #4140FD;",
        "  --brand-primary-hover:         #3534DF;",
        "  --brand-primary-active:        #2B2AC2;",
        "  --brand-primary-subtle:        rgba(65, 64, 253, 0.08);",
        "  --brand-secondary:             #6572F2;",
        "  --brand-accent:                #A39CF9;",
        "  --brand-mist:                  #EFF3FB;",
        "  --brand-gradient:              linear-gradient(115deg, #A39CF9 0%, #6572F2 50%, #4140FD 100%);",
        "",
        "  /* Backward compatibility variables */",
        "  --color-theme-light:           " + colors["theme_light"] + ";",
        "  --color-theme-dark:            " + colors["theme_dark"] + ";",
        "  --color-bg-light:              " + colors["background_light"] + ";",
        "  --color-bg-dark:               " + colors["background_dark"] + ";",
        "  --color-surface-light:         " + colors["surface_light"] + ";",
        "  --color-surface-dark:          " + colors["surface_dark"] + ";",
        "  --color-text-light:            " + colors["text_light"] + ";",
        "  --color-text-dark:             " + colors["text_dark"] + ";",
        "",
        "  /* Typography System */",
        "  --font-family-base:            " + typ["font_family"] + ";",
        "  --font-size-2xs:               0.625rem;  /* 10px */",
        "  --font-size-xs:                0.75rem;   /* 12px */",
        "  --font-size-sm:                0.84375rem;/* 13.5px */",
        "  --font-size-base:              0.9375rem; /* 15px */",
        "  --font-size-md:                1rem;      /* 16px */",
        "  --font-size-lg:                1.125rem;  /* 18px */",
        "  --font-size-xl:                1.25rem;   /* 20px */",
        "  --font-size-2xl:               1.5rem;    /* 24px */",
        "  --font-size-3xl:               1.875rem;  /* 30px */",
        "  --font-size-4xl:               2.25rem;   /* 36px */",
        "  --font-size-5xl:               3rem;      /* 48px */",
        "",
        "  /* Motion & Physics */",
        "  --ease-spring:                 cubic-bezier(0.16, 1, 0.3, 1);",
        "  --ease-smooth:                 cubic-bezier(0.4, 0, 0.2, 1);",
        "  --ease-out-expo:               cubic-bezier(0.19, 1, 0.22, 1);",
        "  --duration-instant:            100ms;",
        "  --duration-fast:               150ms;",
        "  --duration-normal:             250ms;",
        "  --duration-slow:               400ms;",
        "",
        "  /* Default Light Mode Semantic Tokens */",
        "  --color-bg:                    #FFFFFF;",
        "  --color-surface:               #EFF3FB;",
        "  --color-text:                  #1A1A2E;",
        "  --color-theme:                 #FFFFFF;",
        "",
        "  --surface-canvas:              #FFFFFF;",
        "  --surface-card:                #FFFFFF;",
        "  --surface-elevated:            #FFFFFF;",
        "  --surface-sunken:              #F4F6FB;",
        "  --surface-subtle:              #F0F4F9;",
        "  --surface-glass:               rgba(255, 255, 255, 0.85);",
        "  --surface-glass-border:        rgba(0, 0, 0, 0.08);",
        "",
        "  --border-subtle:               rgba(0, 0, 0, 0.06);",
        "  --border-default:              rgba(0, 0, 0, 0.10);",
        "  --border-hover:                rgba(0, 0, 0, 0.16);",
        "  --border-highlight:            rgba(255, 255, 255, 0.9);",
        "  --border-focus:                #4140FD;",
        "",
        "  --text-primary:                #1A1A2E;",
        "  --text-secondary:              #5A5E72;",
        "  --text-tertiary:               #888C9E;",
        "  --text-muted:                  #9CA3AF;",
        "  --text-inverse:                #F4F4F5;",
        "  --text-brand:                  #4140FD;",
        "",
        "  --feedback-success:            #10B981;",
        "  --feedback-success-subtle:     rgba(16, 185, 129, 0.08);",
        "  --feedback-warning:            #F59E0B;",
        "  --feedback-warning-subtle:     rgba(245, 158, 11, 0.08);",
        "  --feedback-danger:             #EF4444;",
        "  --feedback-danger-subtle:      rgba(239, 68, 68, 0.08);",
        "  --feedback-info:               #3B82F6;",
        "  --feedback-info-subtle:        rgba(59, 130, 246, 0.08);",
        "",
        "  --shadow-card:                 0 1px 3px rgba(0, 0, 0, 0.05), 0 4px 12px rgba(0, 0, 0, 0.04);",
        "  --shadow-modal:                0 12px 36px -4px rgba(0, 0, 0, 0.12), 0 4px 16px -2px rgba(0, 0, 0, 0.08);",
        "  --shadow-glow-brand:           0 0 24px -4px rgba(65, 64, 253, 0.22);",
        "  --shadow-inner-specular:       inset 0 1px 0 0 rgba(255, 255, 255, 0.85);",
        "  --skeleton-shimmer-from:       #EFF3FB;",
        "  --skeleton-shimmer-via:        #E2E6F0;",
        "  --skeleton-shimmer-to:         #EFF3FB;",
        "}",
        "",
        "/* Dark Mode Override via .dark class on html element */",
        "html.dark {",
        "  --color-bg:                    #0C0C0E;",
        "  --color-surface:               #18181B;",
        "  --color-text:                  #F4F4F5;",
        "  --color-theme:                 #0C0C0E;",
        "",
        "  --brand-primary-subtle:        rgba(163, 156, 249, 0.12);",
        "",
        "  --surface-canvas:              #0C0C0E;",
        "  --surface-card:                #18181B;",
        "  --surface-elevated:            #202024;",
        "  --surface-sunken:              #121215;",
        "  --surface-subtle:              #1C1C20;",
        "  --surface-glass:               rgba(24, 24, 27, 0.85);",
        "  --surface-glass-border:        rgba(255, 255, 255, 0.08);",
        "",
        "  --border-subtle:               rgba(255, 255, 255, 0.06);",
        "  --border-default:              rgba(255, 255, 255, 0.10);",
        "  --border-hover:                rgba(255, 255, 255, 0.16);",
        "  --border-highlight:            rgba(255, 255, 255, 0.12);",
        "  --border-focus:                #6572F2;",
        "",
        "  --text-primary:                #F4F4F5;",
        "  --text-secondary:              #A1A1AA;",
        "  --text-tertiary:               #71717A;",
        "  --text-muted:                  #52525B;",
        "  --text-inverse:                #1A1A2E;",
        "  --text-brand:                  #A39CF9;",
        "",
        "  --feedback-success:            #34D399;",
        "  --feedback-success-subtle:     rgba(52, 211, 153, 0.12);",
        "  --feedback-warning:            #FBBF24;",
        "  --feedback-warning-subtle:     rgba(251, 191, 36, 0.12);",
        "  --feedback-danger:             #F87171;",
        "  --feedback-danger-subtle:      rgba(248, 113, 113, 0.12);",
        "  --feedback-info:               #60A5FA;",
        "  --feedback-info-subtle:        rgba(96, 165, 250, 0.12);",
        "",
        "  --shadow-card:                 0 1px 3px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.3);",
        "  --shadow-modal:                0 16px 48px -4px rgba(0, 0, 0, 0.6), 0 4px 20px -2px rgba(0, 0, 0, 0.4);",
        "  --shadow-glow-brand:           0 0 32px -4px rgba(101, 114, 242, 0.28);",
        "  --shadow-inner-specular:       inset 0 1px 0 0 rgba(255, 255, 255, 0.09);",
        "  --skeleton-shimmer-from:       #18181B;",
        "  --skeleton-shimmer-via:        #27272A;",
        "  --skeleton-shimmer-to:         #18181B;",
        "}",
        "",
        "/* Media query dark fallback */",
        "@media (prefers-color-scheme: dark) {",
        "  :root:not(.light) {",
        "    --color-bg:                  #0C0C0E;",
        "    --color-surface:             #18181B;",
        "    --color-text:                #F4F4F5;",
        "    --color-theme:               #0C0C0E;",
        "",
        "    --brand-primary-subtle:      rgba(163, 156, 249, 0.12);",
        "    --surface-canvas:            #0C0C0E;",
        "    --surface-card:              #18181B;",
        "    --surface-elevated:          #202024;",
        "    --surface-sunken:            #121215;",
        "    --surface-subtle:            #1C1C20;",
        "    --surface-glass:             rgba(24, 24, 27, 0.85);",
        "    --surface-glass-border:      rgba(255, 255, 255, 0.08);",
        "",
        "    --border-subtle:             rgba(255, 255, 255, 0.06);",
        "    --border-default:            rgba(255, 255, 255, 0.10);",
        "    --border-hover:              rgba(255, 255, 255, 0.16);",
        "    --border-highlight:          rgba(255, 255, 255, 0.12);",
        "    --border-focus:              #6572F2;",
        "",
        "    --text-primary:              #F4F4F5;",
        "    --text-secondary:            #A1A1AA;",
        "    --text-tertiary:             #71717A;",
        "    --text-muted:                #52525B;",
        "    --text-inverse:              #1A1A2E;",
        "    --text-brand:                #A39CF9;",
        "",
        "    --shadow-card:               0 1px 3px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.3);",
        "    --shadow-modal:              0 16px 48px -4px rgba(0, 0, 0, 0.6), 0 4px 20px -2px rgba(0, 0, 0, 0.4);",
        "    --shadow-glow-brand:         0 0 32px -4px rgba(101, 114, 242, 0.28);",
        "    --shadow-inner-specular:     inset 0 1px 0 0 rgba(255, 255, 255, 0.09);",
        "    --skeleton-shimmer-from:     #18181B;",
        "    --skeleton-shimmer-via:      #27272A;",
        "    --skeleton-shimmer-to:       #18181B;",
        "  }",
        "}",
        "",
    ]
    return "\n".join(rows)


def apply_css_tokens(b: dict, *, check: bool = False, verbose: bool = False) -> bool:
    new_content = _build_css_tokens(b)
    BRAND_CSS.parent.mkdir(parents=True, exist_ok=True)
    old_content = BRAND_CSS.read_text(encoding="utf-8") if BRAND_CSS.exists() else ""

    if new_content == old_content:
        _log(verbose, "  brand-tokens.css -- no changes")
        return False

    if verbose:
        _print_diff("brand-tokens.css", old_content, new_content)

    if not check:
        BRAND_CSS.write_text(new_content, encoding="utf-8")
        print("[apply_brand] [OK] frontend/css/brand-tokens.css updated")
    return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _log(verbose: bool, msg: str) -> None:
    if verbose:
        print(msg)


def _print_diff(name: str, old: str, new: str) -> None:
    import difflib
    diff = list(difflib.unified_diff(
        old.splitlines(keepends=True),
        new.splitlines(keepends=True),
        fromfile="a/" + name,
        tofile="b/" + name,
        n=3,
    ))
    if diff:
        print("\n--- diff: " + name + " ---")
        sys.stdout.write("".join(diff[:80]))


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="MindPal Design Token Pipeline -- applies brand.json to all generated artifacts."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Dry-run: exit 1 if any generated file is stale (use in CI lint step).",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print a diff of each changed file.",
    )
    args = parser.parse_args()

    print("[apply_brand] Reading " + str(BRAND_FILE.relative_to(ROOT)))
    brand = load_brand()
    name = brand["identity"]["name"]
    mode = "check" if args.check else "apply"
    print("[apply_brand] Brand: " + name + "  |  mode: " + mode)

    changed = []
    changed.append(apply_index_html(brand, check=args.check, verbose=args.verbose))
    changed.append(apply_webmanifest(brand, check=args.check, verbose=args.verbose))
    changed.append(apply_css_tokens(brand, check=args.check, verbose=args.verbose))

    if args.check and any(changed):
        print("\n[apply_brand] FAIL: Generated files are stale. Run `npm run brand` to fix.")
        sys.exit(1)

    if not any(changed):
        print("[apply_brand] All generated files are up to date.")
    else:
        print("[apply_brand] Done. " + str(sum(changed)) + " file(s) updated.")


if __name__ == "__main__":
    main()
