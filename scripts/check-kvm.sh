#!/usr/bin/env bash
# Laptop readiness check for Firecracker microVMs (native Linux; written for Ubuntu 26.04 + KDE Plasma).
# Read-only: changes nothing, needs no sudo, never creates a VM.
# Usage: scripts/check-kvm.sh [--probe] [--min-ram-gib N] [--min-disk-gib N] [--dir PATH]
#   --probe  also opens /dev/kvm and asks the kernel for its API version (KVM_GET_API_VERSION, no VM is created).
# Exit: 0 = ready (warnings allowed), 1 = at least one FAIL.
set -u
PROBE=0; MIN_RAM=8; MIN_DISK=20; DIR="${PWD}"
while [ $# -gt 0 ]; do
  case "$1" in
    --probe) PROBE=1 ;;
    --min-ram-gib) MIN_RAM="$2"; shift ;;
    --min-disk-gib) MIN_DISK="$2"; shift ;;
    --dir) DIR="$2"; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else G=; Y=; R=; N=; fi
FAILS=0; WARNS=0
pass() { printf '%sPASS%s  %s\n' "$G" "$N" "$1"; }
warn() { printf '%sWARN%s  %s\n' "$Y" "$N" "$1"; WARNS=$((WARNS+1)); [ -n "${2:-}" ] && printf '        fix: %s\n' "$2"; }
fail() { printf '%sFAIL%s  %s\n' "$R" "$N" "$1"; FAILS=$((FAILS+1)); [ -n "${2:-}" ] && printf '        fix: %s\n' "$2"; }
info() { printf 'INFO  %s\n' "$1"; }

echo "== Firecracker readiness: $(date '+%Y-%m-%d %H:%M:%S %Z') =="

# 1. OS / architecture / kernel
ARCH=$(uname -m)
case "$ARCH" in x86_64|aarch64) pass "architecture $ARCH" ;; *) fail "architecture $ARCH is not supported by Firecracker (x86_64 or aarch64)" ;; esac
[ "$(uname -s)" = Linux ] || fail "not Linux"
if grep -qi microsoft /proc/version 2>/dev/null; then
  fail "this is WSL; the plan targets native Linux" "run this on the Ubuntu laptop itself"
fi
OSNAME=$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")
info "OS: $OSNAME"
[ -n "${XDG_CURRENT_DESKTOP:-}" ] && info "desktop: $XDG_CURRENT_DESKTOP (nothing is needed from the desktop environment)"
KREL=$(uname -r); KMAJ=${KREL%%.*}; KMIN=${KREL#*.}; KMIN=${KMIN%%.*}
info "kernel $KREL"
if [ "$KMAJ" -lt 5 ] || { [ "$KMAJ" -eq 5 ] && [ "$KMIN" -lt 10 ]; }; then
  fail "host kernel $KREL is older than 5.10" "install a newer kernel (apt install linux-generic-hwe-*)"
elif case "$KMAJ.$KMIN" in 5.10|6.1|6.18) true ;; *) false ;; esac; then
  pass "host kernel $KREL is on Firecracker's supported list (5.10, 6.1, 6.18)"
else
  warn "host kernel $KREL is newer than or between Firecracker's tested host kernels (5.10, 6.1, 6.18)" \
       "usually works; if the smoke test fails, retest on a 6.18 kernel before filing issues"
fi

# 2. CPU virtualization flags
FLAGS=$(grep -m1 -E '^flags' /proc/cpuinfo 2>/dev/null)
VENDOR=""
echo "$FLAGS" | grep -qw vmx && VENDOR=intel
echo "$FLAGS" | grep -qw svm && VENDOR=amd
if [ -n "$VENDOR" ]; then pass "CPU virtualization flag present ($([ "$VENDOR" = intel ] && echo vmx || echo svm))"
else fail "no vmx/svm CPU flag" "enable Intel VT-x / 'Intel Virtualization Technology' or AMD 'SVM Mode' in the BIOS/UEFI (see doc section 'BIOS check')"; fi
HV=0; echo "$FLAGS" | grep -qw hypervisor && HV=1
if [ "$HV" -eq 1 ]; then
  warn "'hypervisor' flag set: this machine is itself a virtual machine, so Firecracker would run NESTED" \
       "use a bare-metal host for production; nested KVM crashed the kernel on the dev box"
else pass "running on bare metal (no 'hypervisor' flag)"; fi
command -v lscpu >/dev/null && info "lscpu: $(lscpu | grep -i -m1 'virtualization:' | sed 's/  */ /g')"

# 3. KVM modules and device
if [ -e /sys/module/kvm ]; then pass "kvm module loaded"; else fail "kvm module not loaded" "sudo modprobe kvm_${VENDOR:-intel}  (kvm_intel or kvm_amd)"; fi
for m in kvm_intel kvm_amd; do
  if [ -e "/sys/module/$m" ]; then
    pass "$m loaded"
    [ -r "/sys/module/$m/parameters/nested" ] && info "$m nested=$(cat /sys/module/$m/parameters/nested) (only matters if you run VMs inside your microVMs)"
  fi
done
if [ ! -e /dev/kvm ]; then
  fail "/dev/kvm does not exist" "enable virtualization in BIOS, then: sudo modprobe kvm_${VENDOR:-intel}; dmesg | grep -i kvm   (look for 'disabled by bios')"
else
  GRP=$(stat -c %G /dev/kvm 2>/dev/null); MODE=$(stat -c %a /dev/kvm 2>/dev/null)
  info "/dev/kvm group=$GRP mode=$MODE"
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then pass "current user ($(id -un)) can read and write /dev/kvm"
  else
    if id -nG | tr ' ' '\n' | grep -qx "$GRP"; then
      fail "you are in group '$GRP' but this shell does not have it yet" "log out and back in (or: newgrp $GRP)"
    elif id -nG "$(id -un)" 2>/dev/null | tr ' ' '\n' | grep -qx "$GRP"; then
      fail "you were added to '$GRP' but this session predates it" "log out and back in"
    else
      fail "no access to /dev/kvm (group '$GRP')" "sudo usermod -aG $GRP \$USER  then log out and in; or per-session: sudo setfacl -m u:\$USER:rw /dev/kvm"
    fi
  fi
  if [ "$PROBE" -eq 1 ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    if command -v python3 >/dev/null; then
      V=$(python3 - <<'PY' 2>&1
import fcntl, os
fd = os.open("/dev/kvm", os.O_RDWR | os.O_CLOEXEC)
print(fcntl.ioctl(fd, 0xAE00))     # KVM_GET_API_VERSION, no VM is created
PY
)
      [ "$V" = 12 ] && pass "KVM API version 12 (probe only; the real test is scripts/fc-smoke.sh)" || fail "KVM probe returned '$V'"
    else warn "python3 missing, skipped --probe"; fi
  fi
fi

# 4. Memory, disk, cgroups, devices, tools
RAM_GIB=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
if [ "$RAM_GIB" -ge "$MIN_RAM" ]; then pass "RAM ${RAM_GIB} GiB (>= ${MIN_RAM})"
elif [ "$RAM_GIB" -ge 4 ]; then warn "RAM ${RAM_GIB} GiB is low (want >= ${MIN_RAM}); one 2 GiB microVM still fits" "close browsers during tests"
else fail "RAM ${RAM_GIB} GiB is too low (want >= ${MIN_RAM})"; fi
AVAIL_GIB=$(df -Pk "$DIR" | awk 'NR==2 {printf "%d", $4/1048576}')
if [ "$AVAIL_GIB" -ge "$MIN_DISK" ]; then pass "free disk ${AVAIL_GIB} GiB in $DIR (>= ${MIN_DISK})"
elif [ "$AVAIL_GIB" -ge 10 ]; then warn "free disk ${AVAIL_GIB} GiB in $DIR is tight (want >= ${MIN_DISK}: Docker image + rootfs + snapshots)"
else fail "free disk ${AVAIL_GIB} GiB in $DIR is too low"; fi
if [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = cgroup2fs ]; then pass "cgroup v2 (needed by the jailer and fast snapshot restore)"
else warn "cgroup v2 not detected" "snapshot restore is slow on cgroup v1; Ubuntu 26.04 is v2 only"; fi
[ -c /dev/net/tun ] && pass "/dev/net/tun present (tap devices for microVM networking)" || warn "/dev/net/tun missing" "sudo modprobe tun"
[ -c /dev/vsock ] && info "/dev/vsock present on host (not required; Firecracker maps vsock to unix sockets)"
for t in curl tar sha256sum jq ip nft; do
  command -v "$t" >/dev/null && pass "tool: $t" || warn "tool missing: $t" "sudo apt install -y $( [ "$t" = ip ] && echo iproute2 || [ "$t" = nft ] && echo nftables || echo "$t")"
done
if command -v mkfs.ext4 >/dev/null; then
  EV=$(mke2fs -V 2>&1 | sed -n 's/.*mke2fs \([0-9.]*\).*/\1/p' | head -1)
  pass "mkfs.ext4 present (e2fsprogs ${EV:-?}; tarball import needs >= 1.47.1)"
else warn "mkfs.ext4 missing" "sudo apt install -y e2fsprogs"; fi
command -v unsquashfs >/dev/null && pass "tool: unsquashfs" || info "unsquashfs missing (only needed for the Firecracker CI rootfs fallback): sudo apt install -y squashfs-tools"
if command -v docker >/dev/null; then
  if docker info >/dev/null 2>&1; then
    pass "docker usable by this user ($(docker --version | cut -d, -f1))"
    info "docker firewall backend: $(docker info --format '{{.FirewallBackend}}' 2>/dev/null || echo unknown)"
  else warn "docker installed but not usable by this user" "sudo usermod -aG docker \$USER then log out and in"; fi
else warn "docker not found (needed to turn the computer image into a rootfs)" "see doc section 'Install on Ubuntu 26'"; fi
if command -v firecracker >/dev/null || [ -x "$HOME/.local/firecracker/bin/firecracker" ]; then pass "firecracker installed"; else info "firecracker not installed yet: scripts/fc-install.sh"; fi
for other in virtualbox vboxdrv; do
  lsmod 2>/dev/null | grep -qw "$other" && warn "$other is loaded; it can conflict with KVM" "stop VirtualBox VMs or use its KVM backend"
done

echo
if [ "$FAILS" -eq 0 ]; then printf '%sREADY%s  (%d warning(s)). Next: scripts/fc-install.sh, then scripts/fc-build-rootfs.sh, then scripts/fc-smoke.sh\n' "$G" "$N" "$WARNS"; exit 0
else printf '%sNOT READY%s  %d failure(s), %d warning(s).\n' "$R" "$N" "$FAILS" "$WARNS"; exit 1; fi
