#!/usr/bin/env bash
# Install Firecracker + jailer (and a test guest kernel) into your home directory. No sudo, nothing system-wide.
# Usage: scripts/fc-install.sh [--prefix DIR] [--version vX.Y.Z] [--no-kernel]
# Result: $PREFIX/bin/{firecracker,jailer}, $PREFIX/kernel/vmlinux  (default PREFIX=$HOME/.local/firecracker)
set -euo pipefail
PREFIX="${HOME}/.local/firecracker"; VERSION=""; GET_KERNEL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift ;;
    --version) VERSION="$2"; shift ;;
    --no-kernel) GET_KERNEL=0 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
ARCH=$(uname -m)
case "$ARCH" in x86_64|aarch64) ;; *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; esac
for t in curl tar sha256sum; do command -v "$t" >/dev/null || { echo "missing tool: $t (sudo apt install -y $t)" >&2; exit 1; }; done

REPO=https://github.com/firecracker-microvm/firecracker
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$REPO/releases/latest" | sed 's#.*/##')
fi
case "$VERSION" in v[0-9]*) ;; *) echo "could not determine a release (got '$VERSION'); pass --version v1.17.0" >&2; exit 1 ;; esac
echo "Firecracker $VERSION ($ARCH) -> $PREFIX"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TGZ="firecracker-${VERSION}-${ARCH}.tgz"
curl -fsSL -o "$TMP/$TGZ" "$REPO/releases/download/$VERSION/$TGZ"
curl -fsSL -o "$TMP/$TGZ.sha256.txt" "$REPO/releases/download/$VERSION/$TGZ.sha256.txt"
( cd "$TMP" && sha256sum -c "$TGZ.sha256.txt" )     # aborts (set -e) on mismatch
tar -xzf "$TMP/$TGZ" -C "$TMP"
mkdir -p "$PREFIX/bin"
install -m 0755 "$TMP/release-${VERSION}-${ARCH}/firecracker-${VERSION}-${ARCH}" "$PREFIX/bin/firecracker"
install -m 0755 "$TMP/release-${VERSION}-${ARCH}/jailer-${VERSION}-${ARCH}" "$PREFIX/bin/jailer"
"$PREFIX/bin/firecracker" --version | head -1
"$PREFIX/bin/jailer" --version | head -1

if [ "$GET_KERNEL" -eq 1 ]; then
  # Guest kernel built by Firecracker CI (virtio, vsock, ext4 built in). Replace with our own kernel later (doc, step P7).
  S3=https://s3.amazonaws.com/spec.ccfc.min
  MM=${VERSION%.*}                                   # v1.17.0 -> v1.17
  KEY=""
  for CI in "$MM" v1.15 v1.14 v1.13 v1.12; do
    KEY=$(curl -fsSL "$S3?list-type=2&prefix=firecracker-ci/$CI/$ARCH/vmlinux-" \
      | grep -oE "firecracker-ci/$CI/$ARCH/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3}" | sort -V | tail -1 || true)
    [ -n "$KEY" ] && break
  done
  [ -n "$KEY" ] || { echo "no CI guest kernel found; supply your own vmlinux in $PREFIX/kernel/" >&2; exit 1; }
  mkdir -p "$PREFIX/kernel"
  curl -fsSL -o "$PREFIX/kernel/vmlinux" "$S3/$KEY"
  echo "guest kernel: $(basename "$KEY") -> $PREFIX/kernel/vmlinux"
fi
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) echo "add to PATH:  echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.profile" ;; esac
echo "done. Next: scripts/check-kvm.sh --probe"
