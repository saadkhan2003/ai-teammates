import json, os, socket, sys, threading, time
sys.path.insert(0, "/opt/desk/src")
import workspace
from egress import firewall

A = "a" * 32
B = "b" * 32
ua = workspace.ensure(A)
ub = workspace.ensure(B)
lo_a, hi_a = firewall.dev_port_range(ua)
lo_b, hi_b = firewall.dev_port_range(ub)
assert (lo_a, hi_a) != (lo_b, hi_b)

def serve(port, uid):
    pid = os.fork()
    if pid == 0:
        os.setgid(uid); os.setuid(uid)
        s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", port)); s.listen(8)
        while True:
            c, _ = s.accept(); c.sendall(b"hi"); c.close()
    return pid

def tcp(host, port, timeout=1.5):
    s = socket.socket(); s.settimeout(timeout)
    try:
        s.connect((host, port))
        return "open"
    except socket.timeout:
        return "timeout"
    except Exception as e:
        return type(e).__name__
    finally:
        s.close()

def as_uid(uid, fn):
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.setgid(uid); os.setuid(uid)
        os.write(w, json.dumps(fn()).encode()); os._exit(0)
    os.close(w); os.waitpid(pid, 0)
    return json.loads(os.read(r, 100000) or b"null")

pids = []
pids.append(serve(lo_a + 1, ua))      # bot A dev server (own range)
pids.append(serve(lo_b + 1, ub))      # bot B dev server
pids.append(serve(8791, 0))           # stand-in egress proxy (root)
pids.append(serve(7700, 0))           # root service that bots must not reach
time.sleep(0.5)

def a_probe():
    return {
        "own_dev_server": tcp("127.0.0.1", lo_a + 1),
        "own_dev_server_localhost6": tcp("::1", lo_a + 1),
        "other_bot_dev_server": tcp("127.0.0.1", lo_b + 1),
        "egress_proxy": tcp("127.0.0.1", 8791),
        "root_service_7700": tcp("127.0.0.1", 7700),
        "direct_internet": tcp("1.1.1.1", 443),
        "metadata_ip": tcp("169.254.169.254", 80),
        "docker_gateway": tcp(os.environ.get("GW", "172.17.0.1"), 80),
        "dns_udp": dns(),
    }
def dns():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(1.5)
    try:
        s.sendto(b"\x00\x01\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01", ("1.1.1.1", 53))
        s.recv(512); return "answered"
    except socket.timeout: return "timeout"
    except Exception as e: return type(e).__name__
    finally: s.close()

out = {"uid_a": ua, "uid_b": ub, "range_a": [lo_a, hi_a],
       "bot_a": as_uid(ua, a_probe),
       "root": {"direct_internet": tcp("1.1.1.1", 443), "to_bot_a_dev": tcp("127.0.0.1", lo_a + 1)}}
for p in pids: os.kill(p, 9)
print(json.dumps(out, indent=1))
