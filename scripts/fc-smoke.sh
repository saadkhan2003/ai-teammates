#!/usr/bin/env bash
# Boot one Firecracker microVM from our rootfs and check that the desktop stack starts inside it.
# Usage: scripts/fc-smoke.sh [--rootfs FILE] [--kernel FILE] [--mem MiB] [--vcpus N] [--timeout S] [--jailer] [--keep]
#   --jailer  run through the jailer (needs sudo): chroot, uid/gid drop, private /dev/kvm node  (hardening path)
# Exit: 0 = FC_SMOKE_OK seen, 1 = failed, 2 = prerequisites missing.
# WARNING: on a machine that is itself a VM (nested KVM) this can crash the host kernel (seen on the dev box).
set -euo pipefail
PREFIX="${HOME}/.local/firecracker"
ROOTFS="$PREFIX/images/rootfs.ext4"; KERNEL="$PREFIX/kernel/vmlinux"
MEM=1536; VCPUS=2; TIMEOUT=120; JAILER=0; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rootfs) ROOTFS="$2"; shift ;; --kernel) KERNEL="$2"; shift ;; --mem) MEM="$2"; shift ;;
    --vcpus) VCPUS="$2"; shift ;; --timeout) TIMEOUT="$2"; shift ;; --jailer) JAILER=1 ;; --keep) KEEP=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
FC=$(command -v firecracker || echo "$PREFIX/bin/firecracker"); JL=$(command -v jailer || echo "$PREFIX/bin/jailer")
[ -x "$FC" ] || { echo "firecracker not found: run scripts/fc-install.sh" >&2; exit 2; }
[ -f "$KERNEL" ] || { echo "kernel not found: $KERNEL (scripts/fc-install.sh)" >&2; exit 2; }
[ -f "$ROOTFS" ] || { echo "rootfs not found: $ROOTFS (scripts/fc-build-rootfs.sh)" >&2; exit 2; }
if [ "$JAILER" -eq 0 ]; then
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "no access to /dev/kvm; run scripts/check-kvm.sh for the fix" >&2; exit 2; }
fi

WORK=$(mktemp -d); LOG="$WORK/serial.log"
cleanup() { if [ "$KEEP" -eq 1 ]; then echo "kept: $WORK"; else rm -rf "$WORK" 2>/dev/null || sudo rm -rf "$WORK"; fi; }
trap cleanup EXIT
BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw rootfstype=ext4 init=/sbin/fc-init fc.mode=smoke"

# Work on a throw-away copy so the base image is never modified (sparse, reflink when the filesystem supports it).
cp --reflink=auto --sparse=always "$ROOTFS" "$WORK/rootfs.ext4"

write_config() {  # write_config KERNEL_PATH ROOTFS_PATH OUT
  cat > "$3" <<JSON
{
  "boot-source": { "kernel_image_path": "$1", "boot_args": "$BOOT_ARGS" },
  "drives": [ { "drive_id": "rootfs", "path_on_host": "$2", "is_root_device": true, "is_read_only": false } ],
  "machine-config": { "vcpu_count": $VCPUS, "mem_size_mib": $MEM }
}
JSON
}

START=$(date +%s%N)
if [ "$JAILER" -eq 0 ]; then
  cp "$KERNEL" "$WORK/vmlinux"
  write_config "$WORK/vmlinux" "$WORK/rootfs.ext4" "$WORK/vm.json"
  echo "booting ($VCPUS vCPU, $MEM MiB) ..."
  set +e
  timeout "$TIMEOUT" "$FC" --no-api --config-file "$WORK/vm.json" < /dev/null > "$LOG" 2>&1
  RC=$?
  set -e
else
  ID="smoke-$$"; JUID=$((100000 + RANDOM % 5000)); BASE="$WORK/jail"
  ROOT="$BASE/firecracker/$ID/root"
  sudo mkdir -p "$ROOT"
  sudo cp "$KERNEL" "$ROOT/vmlinux"; sudo cp "$WORK/rootfs.ext4" "$ROOT/rootfs.ext4"
  write_config "/vmlinux" "/rootfs.ext4" "$WORK/vm.json"; sudo cp "$WORK/vm.json" "$ROOT/vm.json"
  sudo chown -R "$JUID:$JUID" "$ROOT"
  echo "booting through the jailer (uid $JUID, chroot $ROOT) ..."
  set +e
  sudo timeout "$TIMEOUT" "$JL" --id "$ID" --exec-file "$(readlink -f "$FC")" --uid "$JUID" --gid "$JUID" \
       --chroot-base-dir "$BASE" --cgroup-version 2 --resource-limit no-file=2048 \
       -- --no-api --config-file /vm.json < /dev/null > "$LOG" 2>&1
  RC=$?
  set -e
  sudo rmdir "/sys/fs/cgroup/firecracker/$ID" 2>/dev/null || true
fi
END=$(date +%s%N); WALL_MS=$(( (END - START) / 1000000 ))

echo "---- guest output (markers) ----"
if ! grep -E '^FC_' "$LOG"; then echo "(no FC_ markers; last serial lines:)"; tail -n 12 "$LOG" | sed 's/^/  /'; fi
echo "--------------------------------"
UP=$(grep -o 'FC_UPTIME_S=[0-9.]*' "$LOG" | head -1 | cut -d= -f2 || true)
echo "firecracker exit=$RC  wall=${WALL_MS} ms  guest kernel->init=${UP:-?} s"
if grep -q '^FC_SMOKE_OK' "$LOG"; then echo "RESULT: PASS"; exit 0; fi
if grep -q '^FC_SMOKE_FAIL' "$LOG"; then echo "RESULT: FAIL (guest booted; a check failed, see FC_CHECK_FAIL above)"; exit 1; fi
echo "RESULT: FAIL (guest never reached the smoke test). Common causes: no /dev/kvm access, kernel without virtio-blk/ext4, rootfs missing /sbin/fc-init"
exit 1
