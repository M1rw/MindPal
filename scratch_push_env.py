import subprocess
import concurrent.futures

def push_env_var(key, val):
    print(f"[{key}] Pushing...")
    # First remove it (ignore error if it doesn't exist)
    subprocess.run(["npx", "vercel", "env", "rm", key, "production", "preview", "-y"], 
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=True)
    
    # Then add it
    proc = subprocess.Popen(["npx", "vercel", "env", "add", key, "production", "preview"], 
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True)
    stdout, stderr = proc.communicate(input=val.encode('utf-8'))
    
    if proc.returncode == 0:
        print(f"[{key}] SUCCESS")
    else:
        print(f"[{key}] FAILED: {stderr.decode('utf-8').strip()}")

with open(".env.local", "r", encoding="utf-8") as f:
    lines = f.readlines()

env_vars = []
for line in lines:
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    if "=" not in line:
        continue
    key, val = line.split("=", 1)
    env_vars.append((key, val))

# Execute in parallel to speed it up
print(f"Pushing {len(env_vars)} variables to Vercel (Production & Preview)...")
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
    futures = [executor.submit(push_env_var, k, v) for k, v in env_vars]
    concurrent.futures.wait(futures)

print("Done!")
