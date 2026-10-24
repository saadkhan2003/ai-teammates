"""Runs inside a computer as the bot's own uid (never root). Lists, packs and places the bot's saved files
so the API can mirror them to object storage. Symlinks, devices and anything outside BOT_ROOT are ignored."""
import json, os, secrets, stat, sys, tarfile

ROOT = os.environ["BOT_ROOT"]
SKIP_DIRS = {".sync", ".cache", "node_modules", "__pycache__", ".venv", "venv", "tmp", ".tmp", ".npm", ".git-objects-cache"}
SKIP_SUFFIX = (".pyc", ".swp", ".part", ".crdownload")
MAX_FILES = 50000


def inside(path):
    real = os.path.realpath(path)
    return real == ROOT or real.startswith(ROOT + os.sep)


def token():
    try:
        with open(os.path.join(ROOT, ".sync", "token"), encoding="utf-8") as fh:
            return fh.read().strip()[:80]
    except OSError:
        return ""


def manifest():
    files = []
    for top, dirs, names in os.walk(ROOT, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".sync-in-") and not os.path.islink(os.path.join(top, d))]
        for name in names:
            if name.endswith(SKIP_SUFFIX) or name.startswith(".sync-"):
                continue
            full = os.path.join(top, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            rel = os.path.relpath(full, ROOT)
            # mtime goes out as [seconds, nanoseconds]: a 19-digit mtime_ns can look like a
            # card number to the exec output redactor and come back as [REDACTED].
            files.append([rel, st.st_size, st.st_mtime_ns // 1_000_000_000, st.st_mtime_ns % 1_000_000_000])
            if len(files) >= MAX_FILES:
                break
        if len(files) >= MAX_FILES:
            break
    print(json.dumps({"token": token(), "files": files, "truncated": len(files) >= MAX_FILES}))


def pack(want_name):
    # /tmp is a tmpfs the container archive API cannot see, so the request and the result live in BOT_ROOT
    # under random dot names that the manifest skips.
    if not want_name.startswith(".sync-want-") or "/" in want_name:
        raise SystemExit("bad want file")
    want_file = os.path.join(ROOT, want_name)
    fd = os.open(want_file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, encoding="utf-8") as fh:
        want = json.load(fh)
    os.unlink(want_file)
    out = os.path.join(ROOT, ".sync-out-%s.tar" % secrets.token_hex(12))
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    packed = 0
    with os.fdopen(fd, "wb") as raw, tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for rel in want:
            if rel.startswith("/") or ".." in rel.split("/"):
                continue
            full = os.path.join(ROOT, rel)
            if not inside(os.path.dirname(full)):
                continue
            try:
                src = os.open(full, os.O_RDONLY | os.O_NOFOLLOW)
            except OSError:
                continue
            with os.fdopen(src, "rb") as fh:
                st = os.fstat(fh.fileno())
                if not stat.S_ISREG(st.st_mode):
                    continue
                info = tarfile.TarInfo(rel)
                info.size = st.st_size
                info.mtime = st.st_mtime
                info.pax_headers = {"mtime_ns": str(st.st_mtime_ns)}
                tar.addfile(info, fh)
                packed += 1
    print(json.dumps({"tar": out, "files": packed}))


def place(stage_name, new_token):
    stage = os.path.join(ROOT, stage_name)
    if not stage_name.startswith(".sync-in-") or "/" in stage_name or not inside(stage):
        raise SystemExit("bad stage")
    meta = {}
    try:
        with open(os.path.join(stage, ".meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
    except OSError:
        pass
    placed = 0
    for rel, mtime_ns in meta.items():
        if rel.startswith("/") or ".." in rel.split("/"):
            continue
        src = os.path.join(stage, rel)
        dst = os.path.join(ROOT, rel)
        try:
            if os.path.islink(src) or not os.path.isfile(src):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if not inside(os.path.dirname(dst)) or os.path.islink(dst):
                continue
            try:
                if os.lstat(dst).st_mtime_ns > int(mtime_ns):
                    continue  # written on this computer after the pull started: keep the newer local copy
            except FileNotFoundError:
                pass
            os.replace(src, dst)
            os.utime(dst, ns=(int(mtime_ns), int(mtime_ns)), follow_symlinks=False)
            placed += 1
        except OSError:
            continue
    for top, dirs, names in os.walk(stage, topdown=False):
        for name in names:
            try: os.unlink(os.path.join(top, name))
            except OSError: pass
        for name in dirs:
            try: os.rmdir(os.path.join(top, name))
            except OSError: pass
    try: os.rmdir(stage)
    except OSError: pass
    write_token(new_token)
    print(json.dumps({"placed": placed}))


def write_token(value):
    sync = os.path.join(ROOT, ".sync")
    os.makedirs(sync, mode=0o700, exist_ok=True)
    if os.path.islink(sync):
        raise SystemExit("bad sync dir")
    tmp = os.path.join(sync, "token.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(value)
    os.replace(tmp, os.path.join(sync, "token"))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "manifest":
        manifest()
    elif mode == "pack":
        pack(sys.argv[2])
    elif mode == "place":
        place(sys.argv[2], sys.argv[3])
    elif mode == "token":
        write_token(sys.argv[2])
        print("{}")
    else:
        raise SystemExit("unknown mode")
