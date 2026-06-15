path = 'e:/Synthos/MindPal/frontend/js/app.js'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
old = 'scrollChatToBottom("smooth")'
new = 'scrollChatToBottom("auto")'
count = content.count(old)
content = content.replace(old, new)
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
print(f'Replaced {count} occurrences')
