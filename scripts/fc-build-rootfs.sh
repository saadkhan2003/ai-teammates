#!/usr/bin/env bash
# Turn our Docker computer image into a bootable ext4 rootfs for Firecracker.
# Usage: scripts/fc-build-rootfs.sh [--image teammates-computer:dev] [--out DIR] [--extra-mb 1024]
# Prereq: the image exists locally (docker compose build computer-image) and docker is usable by this user.
# Output: DIR/rootfs.ext4 (sparse), default DIR=$HOME/.local/firecracker/images
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMAGE="teammates-computer:dev"; OUT="${HOME}/.local/firecracker/images"; EXTRA_MB=1024
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift ;; --out) OUT="$2"; shift ;; --extra-mb) EXTRA_MB="$2"; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
for t in docker mkfs.ext4 truncate; do command -v "$t" >/dev/null || { echo "missing tool: $t (sudo apt install -y e2fsprogs coreutils; docker: see doc)" >&2; exit 1; }; done
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not found. Build it: docker compose build computer-image" >&2; exit 1; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

# 1. Thin layer on top of the image: guest PID 1 only. The image itself is not modified.
cp "$HERE/fc/fc-init" "$TMP/fc-init"
cat > "$TMP/Dockerfile" <<DOCKER
FROM ${IMAGE}
COPY fc-init /sbin/fc-init
RUN chmod 0755 /sbin/fc-init && mkdir -p /sys /proc /dev /run /tmp /var/tmp
DOCKER
docker build -q -t teammates-computer-fc:build "$TMP" >/dev/null
echo "built teammates-computer-fc:build from $IMAGE"

# 2. Export the flattened filesystem.
CID=$(docker create teammates-computer-fc:build /bin/true)
docker export "$CID" > "$TMP/rootfs.tar"; docker rm "$CID" >/dev/null
TAR_MB=$(( $(stat -c %s "$TMP/rootfs.tar") / 1048576 ))
SIZE_MB=$(( TAR_MB * 13 / 10 + EXTRA_MB ))
echo "filesystem ${TAR_MB} MiB, image size ${SIZE_MB} MiB (sparse)"

# 3. Make the ext4 image. e2fsprogs >= 1.47.1 reads a tarball and keeps owners without root.
IMG="$OUT/rootfs.ext4"; rm -f "$IMG"; truncate -s "${SIZE_MB}M" "$IMG"
if mkfs.ext4 -q -F -L fcroot -d "$TMP/rootfs.tar" "$IMG" 2>"$TMP/mkfs.err"; then
  echo "created $IMG via mkfs.ext4 -d <tarball>"
else
  echo "mkfs.ext4 cannot import tarballs here ($(head -1 "$TMP/mkfs.err")); using sudo + directory import"
  mkdir "$TMP/root"
  sudo tar --numeric-owner -xpf "$TMP/rootfs.tar" -C "$TMP/root"
  rm -f "$IMG"; truncate -s "${SIZE_MB}M" "$IMG"
  sudo mkfs.ext4 -q -F -L fcroot -d "$TMP/root" "$IMG"
  sudo chown "$(id -u):$(id -g)" "$IMG"; sudo rm -rf "$TMP/root"
fi
e2fsck -fn "$IMG" >/dev/null 2>&1 && echo "e2fsck: clean" || echo "e2fsck reported problems (check manually)"
ls -lh "$IMG" | awk '{print "result:", $9, $5, "(apparent size)"}'
echo "next: scripts/fc-smoke.sh --rootfs $IMG"
