import json
import resource
import subprocess
import sys

# Runs inside the bot computer. Caps are applied before the plugin process starts.
resource.setrlimit(resource.RLIMIT_AS, (268435456, 268435456))
resource.setrlimit(resource.RLIMIT_CPU, (4, 4))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_FSIZE, (1048576, 1048576))
command = json.loads(sys.argv[1])
payload = sys.argv[2]
limit = float(sys.argv[3]) if len(sys.argv) > 3 else 6
proc = subprocess.run(command, input=payload, text=True, capture_output=True, timeout=limit)
sys.stdout.write(proc.stdout[:32768])
