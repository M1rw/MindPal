import urllib.request
for path in ['/api/health','/api/health/live','/api/health/ready']:
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000' + path, timeout=15) as r:
            body = r.read().decode()
            print(path, r.status, body)
    except Exception as e:
        print(path, 'ERROR', repr(e))
