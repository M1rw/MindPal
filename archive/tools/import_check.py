import importlib
import traceback
import sys
from pathlib import Path

# Ensure project root is on sys.path so `src.` imports resolve like when running the bot.
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))

mods = [
    'src.cogs.support',
    'src.cogs.ai_companion',
    'src.cogs.cognitive_tools',
    'src.utils.ui',
    'src.utils.ai_companion_config',
    'src.utils.config',
]

ok = True
for m in mods:
    try:
        importlib.import_module(m)
        print('IMPORTED', m)
    except Exception:
        ok = False
        print('FAILED', m)
        traceback.print_exc()

if ok:
    print('ALL_OK')
else:
    sys.exit(2)
