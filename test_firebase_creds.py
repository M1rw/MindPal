import json
import base64

# Read the minified JSON
with open('firebase-credentials-minified.json', 'r', encoding='utf-8') as f:
    creds = json.load(f)

# Check the private key
pk = creds.get('private_key', '')
print(f"Private key length: {len(pk)}")
print(f"Private key is valid: {pk.startswith('-----BEGIN PRIVATE KEY-----')}")
print(f"First 100 chars: {pk[:100]}")
print(f"\nTrying to encode/decode...")

# Create clean minified JSON
minified = json.dumps(creds, separators=(',', ':'))
print(f"Minified JSON length: {len(minified)}")

# Encode to base64
b64 = base64.b64encode(minified.encode('utf-8')).decode('ascii')
print(f"Base64 length: {len(b64)}")
print(f"Base64 valid chars: {all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=' for c in b64)}")

# Try to decode
try:
    decoded = base64.b64decode(b64, validate=True)
    decoded_str = decoded.decode('utf-8')
    result = json.loads(decoded_str)
    print(f"Decoding successful!")
    print(f"Project ID: {result.get('project_id')}")
    print(f"\nValid base64 string:")
    print(b64)
except Exception as e:
    print(f"ERROR: {e}")
    print(f"First 200 chars of base64: {b64[:200]}")
