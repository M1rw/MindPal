import html.parser
import sys

class HTMLChecker(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []
        self.ids = set()
        
    def handle_starttag(self, tag, attrs):
        if tag not in ["meta", "link", "img", "br", "hr", "input", "source"]:
            self.stack.append(tag)
        for attr, val in attrs:
            if attr == "id":
                if val in self.ids:
                    self.errors.append(f"Duplicate ID: {val}")
                self.ids.add(val)
                
    def handle_endtag(self, tag):
        if tag in ["meta", "link", "img", "br", "hr", "input", "source"]:
            return
        if not self.stack:
            self.errors.append(f"End tag </{tag}> with no open tags.")
            return
        
        # We allow some mismatches for optional end tags or similar, but let's be strict
        expected = self.stack.pop()
        if expected != tag:
            self.errors.append(f"Mismatched tag: Expected </{expected}>, got </{tag}>")
            # Push it back to try to recover slightly
            self.stack.append(expected)

def check_file(filename):
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()
        
    checker = HTMLChecker()
    checker.feed(content)
    
    if checker.stack:
        checker.errors.append(f"Unclosed tags: {checker.stack}")
        
    if checker.errors:
        print(f"Errors in {filename}:")
        for err in checker.errors:
            print(f" - {err}")
    else:
        print(f"No basic HTML errors found in {filename}.")

if __name__ == "__main__":
    check_file(sys.argv[1])
