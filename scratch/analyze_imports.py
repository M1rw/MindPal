import re
import json
from pathlib import Path

def analyze_imports():
    frontend_dir = Path("e:/Synthos/MindPal/frontend/js")
    import_pattern = re.compile(r'import\s+.*?(?:from\s+)?[\'"]([^\'"]+)[\'"]', re.MULTILINE | re.DOTALL)
    dynamic_import_pattern = re.compile(r'import\([\'"]([^\'"]+)[\'"]\)')
    
    graph = {}
    
    for path in frontend_dir.rglob("*.js"):
        rel_path = path.relative_to(frontend_dir).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = path.read_text(encoding="latin-1")
            
        imports = []
        for match in import_pattern.finditer(content):
            imports.append(match.group(1))
            
        for match in dynamic_import_pattern.finditer(content):
            imports.append(match.group(1))
            
        graph[rel_path] = imports
        
    print(json.dumps(graph, indent=2))

if __name__ == "__main__":
    analyze_imports()
