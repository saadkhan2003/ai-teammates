# Firecracker microVM isolation for AI Teammates

Status: design + prototype tooling, 2026-10-23 (Asia/Karachi). Owner decision: isolation like Grok Bot, one Firecracker microVM per user, per-bot isolation on top.
Evidence tags: **[C]** confirmed by running it on the dev box, **[D]** documented in a public source (listed in section 12), **[I]** my inference or untested.
Related: `BOT_COMPUTER_ARCHITECTURE.md` (§16 is the Docker-level isolation this replaces for cross-user separation).

---

## 1. TL;DR

- **Target:** one Firecracker microVM per user. Inside it, our existing computer image (Debian + Xvfb + xfwm4 + Plank + Chromium + s6) runs unchanged, and the per-bot UIDs and desktop lease keep separating that user's bots from each other. Grok Bot's Teams doc says computers are Firecracker-isolated per user [D: cursor.com/docs/grok-bot/teams], so this is the same boundary.
- **This box cannot run it [C].** `/dev/kvm` exists and the CPU advertises `vmx`, but the box is itself a VM and creating a vCPU crashed the host KVM (kernel log: `kvm_spurious_fault` during `KVM_CREATE_VCPU`; Firecracker v1.17.0 segfaulted 3 of 3 times). Do not retry here.
- **Prototype on Saad's laptop** (Ubuntu 26.04, KDE Plasma, native Linux). Bare metal has working KVM. Section 2 is the step-by-step; five scripts in `scripts/` do the work.
- **Production host:** bare metal (Hetzner AX-series from about EUR 77-97/month, or AWS `*.metal`). Firecracker's own tested hosts are AWS metal and Graviton [D].
- **Build first:** (1) boot our rootfs in a microVM and see Xvfb + Chromium start (`fc-smoke.sh`, about 1 day), (2) a vsock agent so `exec` and VNC work without any guest network (about 3 days), (3) a `Compute.Firecracker` provider that passes the existing `tests/compute-contract` suite (about 6 days). Total plan: about 33 engineer-days (section 9).

---

## 2. Prototype on Saad's laptop (Ubuntu 26.04 + KDE Plasma)

### 2.1 What you need and what you don't

- Ubuntu 26.04 LTS ships Linux 7.0, cgroup v2 only, and an nftables-backed `iptables` [D: Ubuntu release notes; ComputingForGeeks]. Firecracker's supported host kernels are 5.10, 6.1 and 6.18; 7.0 is newer than the tested list [D], so expect it to work but report the exact kernel with any bug [I]. If it misbehaves, boot the 6.18-or-lower kernel from GRUB's advanced menu.
- **KDE Plasma needs nothing.** The microVM's desktop is Xvfb inside the guest, shown through VNC/noVNC in a browser. No Wayland/X11 setup, no virt-manager, no libvirt, no QEMU on the laptop [I].
- Native Linux only: no WSL2, no Windows tooling.
- Hardware: x86_64 with VT-x/AMD-V enabled, 8 GiB RAM or more (one smoke VM is 1.5 GiB), 20 GiB free disk.

### 2.2 BIOS/UEFI check (do this first)

1. Run `grep -cE 'vmx|svm' /proc/cpuinfo`. Non-zero means the CPU flag is visible. Zero means virtualization is off in firmware (or the CPU lacks it).
2. If zero: reboot into the BIOS/UEFI setup and enable **Intel Virtualization Technology (VT-x)** on Intel or **SVM Mode** on AMD. Vendors name it differently ("Virtualization", "Intel VT-x", "SVM"). Secure Boot can stay on.
3. After boot: `sudo dmesg | grep -i kvm` should not say `disabled by bios`, and `ls -l /dev/kvm` should show it (group `kvm`, mode 0660) [I: Ubuntu's udev default].
4. If a hypervisor like VirtualBox with its own kernel module is loaded, stop its VMs; two hypervisors do not share VT-x well [I].

### 2.3 Install (apt)

```bash
sudo apt update
sudo apt install -y cpu-checker curl jq tar acl e2fsprogs squashfs-tools nftables iproute2
# Docker only if you do not have it yet (needed to build our image and run the existing compose stack):
#   sudo apt install -y docker.io docker-compose-v2      # or Docker's own apt repo
sudo usermod -aG kvm,docker "$USER"      # then LOG OUT AND BACK IN (group membership is read at login)
kvm-ok                                   # from cpu-checker: "KVM acceleration can be used"
```

Then, from the repo root (`src/` in this tree):

```bash
scripts/check-kvm.sh --probe      # read-only readiness report; exit 0 = ready
scripts/fc-install.sh             # Firecracker + jailer + test guest kernel into ~/.local/firecracker (no sudo)
docker compose build computer-image          # builds teammates-computer:dev
scripts/fc-build-rootfs.sh        # image -> ~/.local/firecracker/images/rootfs.ext4
scripts/fc-smoke.sh               # boots a microVM and checks Xvfb, xfwm4, Plank, Chromium
scripts/fc-smoke.sh --jailer      # same, through the jailer (uses sudo)
```

| Script | What it does | Tested where |
|---|---|---|
| `scripts/check-kvm.sh` | Architecture, kernel vs supported list, `vmx/svm`, hypervisor flag (nested warning), `kvm` modules, `/dev/kvm` access and the exact fix, `--probe` (opens `/dev/kvm` and asks `KVM_GET_API_VERSION`; creates no VM), RAM, disk, cgroup v2, `/dev/net/tun`, tools, Docker, VirtualBox clash | [C] ran on the dev box (correctly reports not-ready: no `/dev/kvm` access, nested warning). Not yet run on the laptop |
| `scripts/fc-install.sh` | Downloads a Firecracker release (latest or `--version`), verifies its sha256, installs `firecracker` and `jailer`, fetches a CI guest kernel | [C] ran to a scratch dir on the dev box: sha256 OK, v1.17.0 binaries and a 6.1.x guest kernel fetched |
| `scripts/fc-build-rootfs.sh` | Adds a tiny PID-1 shim (`scripts/fc/fc-init`) on top of our image, `docker export`, `mkfs.ext4 -d` into a sparse ext4 (falls back to sudo directory import if e2fsprogs is older than 1.47.1) | `bash -n` only: Docker and `mkfs.ext4` are unavailable to the dev box user |
| `scripts/fc-smoke.sh` | Copies the rootfs to a temp file, boots with `--no-api --config-file`, parses `FC_*` markers on the serial console, prints pass/fail and boot time. `--jailer` runs it in a chroot with a dropped UID | Prerequisite handling only [C]. **The boot itself and `--jailer` are untested: they cannot run on this box** |
| `scripts/fc/fc-init` | Guest PID 1: mounts, runs checks (Python, Node, Xvfb, xfwm4, Plank, Chromium version, a real Xvfb display, headless Chromium), prints `FC_SMOKE_OK` or `FC_SMOKE_FAIL`, then reboots so Firecracker exits. `fc.mode=full` hands over to the image's s6 `/init` | `sh -n` only |

Expected first run: the smoke may fail on one item (for example Plank needing a library, or Chromium needing `--no-sandbox` as root). `FC_CHECK_FAIL` lines say which. That is the point of step 1; fix the image, not the script.

### 2.4 Docker coexistence on Ubuntu 26

Docker keeps doing what it does today (builds the image, runs `caddy/web/api/agent/postgres`). Firecracker runs beside it. Things to know:

1. **KVM and Docker do not conflict.** Containers do not use `/dev/kvm`.
2. **Forwarding.** Docker enables IP forwarding and sets the forward policy to drop unless packets are explicitly accepted [D: docs.docker.com packet-filtering]. A drop in Docker's chain is final, so microVM egress needs an accept in `DOCKER-USER` (the chain Docker leaves for admins) or Docker's `--ip-forward-no-drop`, which we do not want. Do not change the Docker daemon; put our accept rules in `DOCKER-USER` and our default-deny in our own nft table (section 4.5).
3. **Firewall backend.** Docker 29 reportedly ships with the nftables backend on Ubuntu 26.04 [D: secondary source, mondoo.com]; the Docker docs call the nftables backend experimental in the version I read [D]. Run `docker info --format '{{.FirewallBackend}}'` (the check script prints it). **Our existing `deploy/isolation-guard` repairs `DOCKER-USER` with `iptables-legacy` [C: repo]; on an nftables-backend host those rules may not take effect.** Verify with the cross-container test in §10 before trusting the Docker-level isolation on the laptop.
4. **Name clashes.** All our nft objects live in `table inet fcguard` and taps are named `fc-<id>`; nothing touches Docker's tables.
5. **Memory.** Docker stack (about 1 GiB under the lowend cgroup) plus a 1.5-3 GiB microVM fits in 8 GiB; 16 GiB is comfortable.

### 2.5 Remote access later

Code is written here and run there. When Saad grants remote access: SSH over Tailscale or a Cloudflare Tunnel (never an open port 22 to the internet), run the same five scripts over SSH, and open the noVNC URL through the tunnel. The account only needs to be in the `kvm` and `docker` groups; `--jailer` mode and the later `fcd` service need `sudo` for `jailer`, `ip` and `nft` only [I].

---

## 3. Feasibility

### 3.1 This box [C]

| Check | Result |
|---|---|
| OS / kernel | Debian 13, kernel 6.12.94+, x86_64 |
| CPU | `vmx` present, `hypervisor` flag set (the box is a VM), 15 GiB RAM, 72 GiB free |
| `/dev/kvm` | present, `root:103` 0660; `kvm_intel nested=Y` |
| Tools | no `mkfs.ext4`, `unsquashfs`, `bc`, `nft`; Docker daemon not usable by the box user |
| Firecracker v1.17.0 boot | **segfault on 3 of 3 attempts**; kernel log showed a KVM oops (`kvm_spurious_fault` in `KVM_CREATE_VCPU`) |

**Verdict: no microVM of any KVM-based kind (Firecracker, Cloud Hypervisor, Kata with KVM) can run on this box.** The advertised nested flag is not usable in practice; I stopped after three attempts and left the box up. Everything that runs here is a non-KVM fallback.

### 3.2 Fallbacks for development when KVM is absent

| Option | Works without KVM? | What it proves | Rough cost |
|---|---|---|---|
| **Saad's laptop (native Ubuntu)** | uses real KVM | everything in this doc | EUR 0 |
| Hetzner dedicated AX42-1 | bare metal, KVM works [I] | production-like | EUR 97.30/mo + EUR 49 setup (AX42-1-LTD EUR 77.30/mo; AX102-1 EUR 257.30/mo), excl. VAT, after the 15 Jun 2026 price adjustment [D: hetzner.com] |
| AWS bare metal `c5.metal` | yes [D] | production-like, Firecracker's tested platform | $4.08/h = about $2,938/mo on demand (us-east-1) [D: aws.amazon.com/ec2/pricing] |
| AWS `c7i.metal-24xl` | yes [D] | same | $4.284/h = about $3,127/mo; spot about $873/mo [D] (use hourly; stop when not testing) |
| AWS nested virtualization on 7i/8i virtual instances | announced Feb 2026, extended Jun 2026 [D] | quick tests; AWS recommends bare metal for performance work | normal instance price |
| gVisor `runsc` (systrap platform) | yes: systrap is the default and needs no KVM [D: gvisor.dev] | user-space-kernel isolation of containers, not a microVM; Chromium/Xvfb compatibility untested [I] | EUR 0 |
| Kata Containers with QEMU TCG | emulated CPU, functional only, very slow [D] | orchestration wiring only | EUR 0 |
| `Compute.Fake` + contract tests | yes | orchestrator logic, API, lease | EUR 0 |

Short-term plan for work on this box: write and unit-test everything that does not need a guest (the nft ruleset generator, the orchestrator state machine against `Compute.Fake`, the vsock framing) here, and run the guest-dependent tests on the laptop.

### 3.3 Likely deployment hosts

- **Bare metal** is the recommended path: full-speed KVM, no nested penalty, Firecracker's documented production setup [D: prod-host-setup.md].
- Hetzner's Ryzen servers are not in Firecracker's tested list (AWS metal on Intel Cascade Lake / Ice Lake / Sapphire Rapids / Granite Rapids, AMD Milan / Genoa, Graviton) [D]; plain KVM works on any AMD-V host, so expect fine, but run the full test plan (section 10) on the chosen host before launch [I].
- Plain cloud VMs (DigitalOcean, Hetzner Cloud, etc.) mostly do not expose nested KVM; I did not research each one, so treat them as unsupported [U].
- Firecracker's `--no-api` mode, jailer, and cgroup v2 are all available on any of these hosts [D].

---

## 4. Architecture

```
                         HOST (Ubuntu / Debian bare metal, KVM)
 ┌────────────────────────────────────────────────────────────────────────────┐
 │  Docker: caddy, web, api(.NET), agent(Python), postgres, object-store       │
 │                │ unix socket (no TCP)                                       │
 │          ┌─────▼──────┐   creates   ┌──────────── jailer chroot + cgroup ┐  │
 │          │    fcd     │────────────▶│ firecracker (uid N, seccomp, no caps)│ │
 │          │ (privileged│  nft rules, │  ┌────────── microVM (user U) ────┐ │ │
 │          │ orchestr.) │  taps, disk │  │ kernel + rootfs (vda, RO base) │ │ │
 │          └─────┬──────┘             │  │ /home overlay (vdb, per user)  │ │ │
 │   vsock unix sockets  v.sock_<port> │  │ s6: Xvfb, xfwm4, Plank, x11vnc │ │ │
 │   (control, VNC rw, VNC ro)         │  │ Chromium, per-bot UIDs         │ │ │
 │                                     │  │ guest-agent (vsock listener)   │ │ │
 │                                     │  └───────────────┬────────────────┘ │ │
 │                                     └──────── tap fc-U ─┘ (egress only)    │ │
 │   nft table inet fcguard: default drop, per-VM allow rules                  │
 └────────────────────────────────────────────────────────────────────────────┘
```

Boundary: **user to user = hardware virtualization** (KVM + Firecracker's minimal device model, seccomp, jailer). **Bot to bot inside one user's VM = per-bot UIDs, per-bot X auth, per-bot Chromium profile** (what we already have). A bot compromised inside a VM reaches only that user's data and that user's other bots. This matches the stated scope: "one microVM per user, per-bot isolation on top". If a later threat model demands bot-per-VM, restoring clones from a snapshot makes that affordable (section 7).

### 4.1 Guest image and kernel

- **Rootfs from our computer image**: `docker build` a thin layer (adds `/sbin/fc-init`), `docker export`, `mkfs.ext4 -d <tar>` [D: Firecracker docs on rootfs and kernel setup]. Same Dockerfile as today, so the Docker provider and the Firecracker provider share one image pipeline.
- **Guest init**: PID 1 is `fc-init` which mounts proc/sys/dev/cgroup2, then `exec /init` (s6-overlay) in `fc.mode=full`. s6 already supervises Xvfb, xfwm4, Plank, the VNC servers and `bots-init` in the Docker image [C: repo], so no new supervisor is needed.
- **Things Docker gave us for free that the guest now needs**: an `iproute2` package for the IP setup, a `guest-agent` binary/service, `chrony` or an agent-driven clock set after resume, `openssh` is NOT added (no inbound network at all).
- **Kernel**: start with Firecracker CI's `vmlinux` (fc-install downloads it; it is virtio-blk, vsock, ext4 and net built in). Build our own minimal 6.1 or 6.18 guest kernel from Firecracker's recommended config in step P7 [D].
- **Chromium inside a VM**: Chromium's own sandbox needs user namespaces; the guest kernel must enable them. Chromium plus `/dev/shm` of 512 MiB is set by `fc-init` (`--disable-dev-shm-usage` avoids needing more) [I].

### 4.2 vsock agent instead of a network

Firecracker's vsock device exposes guest `AF_VSOCK` sockets as host Unix sockets: for a host-initiated connection, the host connects to `<uds_path>` and sends `CONNECT <port>\n`; for guest-initiated connections to CID 2, Firecracker connects to `<uds_path>_<port>` on the host [D: docs/vsock.md]. So there is no IP path between the control plane and the guest, and the guest cannot reach anything on the host except the listeners we create.

| vsock port | Direction | Purpose |
|---|---|---|
| 5000 | host to guest | control RPC (length-prefixed JSON or protobuf): `ping`, `exec`, `put/get file`, `desktop-info`, `freeze/thaw fs`, `set-clock`, `shutdown`, `reseed` |
| 5001 | host to guest | VNC read-write (guest `x11vnc` bound to a unix/vsock bridge, never TCP on the guest network) |
| 5002 | host to guest | VNC read-only (`x11vnc -viewonly`; same split as `desktops.py` today) |
| 5003 | host to guest | CDP / Chromium remote debugging for the worker (replaces TCP to 172.30.x) |
| 6000 | guest to host | agent events (heartbeat, desktop state, file-change notices) |

Rules: the bridge on the host side (`fcd`) enforces **the desktop lease and FencingEpoch before it splices a client onto 5001**; read-only viewers only ever get 5002. Frame length limit of 1 MiB with a 5 s read timeout so a hostile guest cannot exhaust host memory or hang a worker [I]. The guest agent is small, runs as root inside the VM, and is the only listener the host talks to; it exposes no shell to the network.

Mapping to today: `agent` (Python worker) currently reaches computers over TCP on the `computers` network at 172.30.28.x [C: compose]; it will instead call `fcd` over its unix socket, which proxies to the VM's `v.sock`.

### 4.3 Jailer, seccomp, cgroups

`fcd` never runs Firecracker directly; it launches it through the **jailer** [D: docs/jailer.md], which:

- creates a per-VM chroot and `pivot_root`s into it (only the kernel, the drives, the sockets are visible),
- `mknod`s only `/dev/kvm` and `/dev/net/tun` inside the jail,
- drops to a unique non-root uid/gid per VM, optionally in a new PID namespace (`--new-pid-ns`) and a named network namespace (`--netns`),
- places the process into cgroup v2 (`--cgroup-version 2`, `--parent-cgroup`), applies `setrlimit` via `--resource-limit` (`no-file`, `fsize`).

Firecracker itself applies a per-thread seccomp filter [D: docs/seccomp.md]; leave the default filter on. Per-VM uid range: 100000 + vmIndex, never reused for a different user while files may remain.

Command shape (prototype `--jailer` mode in `fc-smoke.sh`, [I] untested here):

```bash
sudo jailer --id "$ID" --exec-file /path/firecracker --uid "$UID_" --gid "$UID_" \
  --chroot-base-dir /srv/fc --cgroup-version 2 --parent-cgroup fcd \
  --resource-limit no-file=2048 --new-pid-ns --netns /var/run/netns/fc-$ID \
  -- --no-api --config-file /vm.json
```

### 4.4 Memory, CPU, disk limits

| Resource | Mechanism |
|---|---|
| vCPU | `machine-config.vcpu_count` (2 default) **and** cgroup `cpu.max` at 2x vCPU quota plus a small overhead for the VMM thread |
| Memory | `mem_size_mib` (default 3072, 1536 for the lowend profile) and cgroup `memory.max` = guest RAM + about 128 MiB VMM overhead; **balloon** device with `deflate_on_oom` and free-page reporting reclaims idle memory [D: docs/ballooning.md] |
| Process count | cgroup `pids.max` on the VMM; guest-internal limits via s6/ulimit |
| Disk IO | Firecracker per-drive `rate_limiter` (bandwidth + ops) and cgroup `io.max` |
| Network | Firecracker `rx_rate_limiter` / `tx_rate_limiter` on the net device plus nft rate limits |
| Host hardening | follow `prod-host-setup.md`: SMT/mitigations policy, no swap on the VM host, KSM off [D] |

### 4.5 Networking: routed taps, per-VM nftables default-deny

Firecracker gives the guest a TUN/TAP device and does no filtering, so all egress control is on the host [D: docs/network-setup.md; it recommends `nft`]. Design:

- **Routed, not bridged**: each VM gets its own tap `fc-<idx>` and a point-to-point /30 out of `10.200.0.0/16` (host `.1`, guest `.2`). No shared L2 means no ARP/MAC spoofing between VMs and no broadcast path [I].
- **Optional netns** per VM (`--netns`) when we want the tap and its rules isolated from the host's main namespace.
- **Default deny**, one table, generated and replaced atomically by `fcd` with `nft -f`:

```nft
table inet fcguard {
  set vm_taps { type ifname; }                      # fc-1, fc-2, ...
  chain input {                                     # traffic to the host itself
    type filter hook input priority -10; policy accept;
    iifname @vm_taps udp dport 53 ip daddr 10.200.0.1 accept   # only our resolver on the host
    iifname @vm_taps drop                                       # nothing else reaches the host
  }
  chain forward {
    type filter hook forward priority -10; policy accept;       # Docker's own policy is separate
    # anti-spoof: a VM may only source its own address
    iifname "fc-1" ip saddr != 10.200.1.2 drop
    # never to other VMs, RFC1918, link-local/metadata, the LAN, the host's addresses
    iifname @vm_taps oifname @vm_taps drop
    iifname @vm_taps ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 } drop
    iifname @vm_taps meta nfproto ipv6 drop
    # per-VM egress: Allow All (default) or an allowlist set per VM
    iifname "fc-1" ip daddr @allow_fc1 accept        # allowlist mode
    iifname "fc-1" accept                            # allow-all mode (replace the rule above)
    iifname @vm_taps drop
  }
  chain postrouting { type nat hook postrouting priority srcnat; policy accept;
    ip saddr 10.200.0.0/16 oifname != "fc-*" masquerade }
}
```

- **Docker interplay** (section 2.4): Docker's forward policy is drop, so the matching accept for `fc-*` traffic also goes in `DOCKER-USER` (or the nft equivalent for the nftables backend), inserted by `fcd`, and re-checked on a timer because the existing guard needs to repair rules after a Docker restart [C: `deploy/isolation-guard`].
- **DNS**: a local resolver on `10.200.0.1` (dnsmasq or unbound). It enforces the team allowlist by domain, which nft alone cannot do, and resolved IPs feed the per-VM allowlist set with a TTL [I]. Same shape as Grok Bot's Network Controls (allow all / defaults + team allowlist / allowlist only) [D: cursor.com/docs/grok-bot/security].
- **IPv6**: disabled in the guest (`ipv6.disable=1` kernel arg) and dropped on the host.
- The old Docker `computers` network, the `COMPUTER_DNS` setting, and `isolation-guard` rules stay for non-microVM mode and are removed after P11.

### 4.6 Disk layout and persistence

| Drive | Mount | Mode | Contents |
|---|---|---|---|
| `vda` | `/` lower layer | **read-only, shared** per image version | Debian + desktop stack. All VMs of one version share one page cache copy [I] |
| `vdb` | `/data`, overlay upper for `/`, and `/home` | read-write, **per user**, sparse ext4 sized to the quota | user files, bot profiles, Chromium profiles, installed packages (overlay upper) |

- The guest mounts overlayfs (`lower=vda`, `upper=vdb/upper`, `work=vdb/work`) before exec'ing s6 [I]. Recreate = wipe the upper layer, keep `/home`.
- New user disk: `cp --reflink=auto` of a template `vdb.ext4` (instant on XFS/btrfs), `resize2fs` up to the quota.
- Backups and "snapshot" at the file level: agent `freeze`, copy the sparse file (or `reflink`), `thaw`. This is what the `snapshots` volume and `scripts/backup.sh` map to.
- Firecracker supports `virtio-blk` only; no virtio-fs and no hotplug [D], so shared host folders are replaced by agent file transfer over vsock and by the object store.

### 4.7 Snapshot, pause, resume

- Firecracker can pause a VM and write a **snapshot** (VM state + guest memory file, full or diff), then restore it into a new Firecracker process [D: docs/snapshotting/snapshot-support.md].
- **Caveats from the docs that shape the design [D]**: a snapshot must not be resumed more than once without handling uniqueness (RNG state, IDs, tokens); network devices are not preserved across restore, so `fcd` recreates the tap with the same name and re-applies nft rules before restore; cgroup v2 is recommended; guest clocks need a resync (agent `set-clock`).
- **Policy**: *Idle-stop by default*: the agent flushes, `fcd` sends Ctrl-Alt-Del / `shutdown`, the VM stops, `vda`+`vdb` stay on disk; next use cold-boots. *Memory snapshot for "pause and resume instantly"* only for users who asked for always-warm computers, because each snapshot costs a memory file (1.5-3 GiB) per user [I]. Measure cold boot with our full desktop (Firecracker claims about 125 ms to start a minimal guest [D: NSDI'20 paper]; ours will be seconds because of Xvfb + Chromium) before deciding.
- **Golden warm template** for new users: boot once, wait for Xvfb/xfwm4/Plank, snapshot, then restore a **copy** per new user with a new `vdb`, new tap, `reseed` over vsock, new tokens. Never restore the same snapshot file into two live VMs without the reseed step [D].

### 4.8 Orchestrator service: `fcd`

A small privileged host daemon (the same pattern as `docker-proxy` + `isolation-guard`): API talks to it over a Unix socket, never TCP, never root in the API container.

| Endpoint | Does |
|---|---|
| `POST /vms` | allocate index, uid, /30, tap, nft entries, data disk (reflink template), write `vm.json` |
| `POST /vms/{id}/start` | create netns/tap, launch via jailer, wait for agent `ping` on vsock 5000 |
| `POST /vms/{id}/pause` / `resume` | Firecracker API `PATCH /vm` Paused/Resumed (after `freeze`) |
| `POST /vms/{id}/snapshot` / `restore` | memory+state snapshot (section 4.7) or disk-only |
| `POST /vms/{id}/stop` | agent `shutdown`, then SendCtrlAltDel, then SIGTERM, then SIGKILL after timeouts |
| `DELETE /vms/{id}` | stop, remove tap, nft entries, chroot, cgroup, data disk (when asked) |
| `POST /vms/{id}/exec`, `GET/PUT /vms/{id}/files` | proxied to the guest agent |
| `GET /vms/{id}/desktop?role=rw|ro` | lease-checked splice to vsock 5001/5002; token carries FencingEpoch |
| `GET /host/capacity`, `GET /health`, `GET /events` | free memory by cgroup budget, process health, state changes |

State: `/var/lib/fcd/vms/<id>/{state.json,vm.json,vdb.ext4}`, written atomically. On `fcd` start it reconciles: every `state.json` against the running processes and the nft set (same shape as the Docker provider's `Watch`). Language: prototype in Python asyncio (HTTP over a Unix socket, no dependencies, same as `isolation-guard`); production can move to Go with the official Firecracker Go SDK [I].

### 4.9 Mapping the Docker provider and compose services

`Compute.Domain` already defines the provider interface (Create/Start/Stop/Restart/Recreate/Delete/Exec/GetDesktopSession/Snapshot/Restore/Capacity/Health/Watch) and `tests/compute-contract/Scenarios.cs` already holds the contract tests, so the new provider is `Compute.Firecracker`, a thin HTTP-over-Unix-socket client of `fcd` [C: repo].

| Provider method | Docker today | Firecracker |
|---|---|---|
| Create | create container, volume, per-bot UIDs via `bots-init` | `POST /vms` (disk, tap, nft, uid) |
| Start / Stop / Restart | container start/stop | jailer boot / agent shutdown / both |
| Recreate | new container, keep volume | new `vda` version, wipe overlay upper, keep `/home` |
| Delete | remove container + volume | `DELETE /vms/{id}` (+ disk) |
| Exec | `docker exec` | vsock 5000 `exec` |
| GetDesktopSession | URL to RW/RO websockify | lease-checked vsock splice (5001/5002) |
| Snapshot / Restore | volume copy | disk reflink copy, or memory snapshot |
| Capacity / Health | Docker info + cgroup | host cgroup budget + agent `ping` |
| Watch | Docker events | `fcd /events` |

| Compose service | After the change |
|---|---|
| `caddy`, `web`, `api`, `postgres`, `object-store` | unchanged, still Docker (control plane) |
| `agent` (worker) | unchanged code; talks to computers through `fcd` (exec, CDP, files over vsock) instead of TCP on `computers` 172.30.28.x |
| `docker-proxy` | stays for image builds and the Docker provider; the Firecracker path uses `fcd` instead |
| `isolation` (guard) | the nft generator moves into `fcd`; the guard remains for the Docker provider |
| `computer-image` | same Dockerfile; plus the `fc-build-rootfs.sh` pipeline step that makes `rootfs.ext4` |
| `computers` network | replaced by routed taps `fc-*` |
| `snapshots` volume | `/var/lib/fcd/snapshots` on a host path |
| `lowend` profile | cgroup budget for `fcd`-launched VMs (fewer vCPUs, 1.5 GiB, balloon on) |

### 4.10 Density and cost [I]

If the host has 64 GiB of RAM and about 8 GiB is reserved for the control plane and host, with 3 GiB guests and ballooning plus idle-stop, expect **15-25 concurrently active users** and many more stopped ones. At EUR 97/month for an AX42-class host that is about EUR 4-7 per active user per month before storage and egress. These numbers are an estimate: measure real RSS of an active desktop with Chromium in P6.

---

## 5. Security properties

| Threat | Defence |
|---|---|
| Guest root escapes to host | KVM boundary + Firecracker's small device model + seccomp + jailer (chroot, non-root uid, cgroup) [D] |
| User A reaches user B's VM | no shared L2 (routed /30), `oifname @vm_taps` drop, separate uid and chroot per VM |
| Guest reaches host services (API, Postgres, Docker socket) | nft `input` policy drops everything except DNS; Docker socket is not reachable, there is no mount |
| Guest reaches cloud metadata / LAN | RFC1918 and 169.254/16 dropped in `forward` |
| Control-plane compromise via guest | vsock bridge with frame limits, timeouts, lease check; agent has no network listener |
| One bot reads another bot's data | per-bot UIDs, X auth, profiles (existing); same-user trust boundary |
| Stale writer after pause/resume | desktop lease and FencingEpoch checked in `fcd` before any splice |

---

## 6. What changes in our repo

- `scripts/`: the five new scripts (this change).
- `services/computer/`: add `iproute2`, `chrony`, `guest-agent`, an overlay-root mount step (new, in `fc-init` `full` mode).
- `Compute.Firecracker/` (new project) + contract test wiring.
- `services/fcd/` (new): orchestrator, nft generator, resolver config.
- `deploy/`: `fcd.service` (systemd, hardened), `fcd-nft.conf`.
- `docs/`: this file; update §10/§14 of `BOT_COMPUTER_ARCHITECTURE.md` once P6 passes.

---

## 7. Per-bot isolation on top

Inside the VM the model is unchanged: one UID per bot, `HOME` per bot, X authority cookie per bot, Chromium profile per bot, the RW/RO desktop split, the lease. Escalation path if stricter bot separation is required later: **bot-per-VM** with CoW disks and snapshot clones (restore clones with reseed; each VM about 1.5 GiB). The orchestrator API above already identifies VMs by `id`, so a user/bot hierarchy is an `fcd` naming decision, not a rewrite [I].

---

## 8. Open risks

1. Our image on Firecracker's guest kernel: Plank (GTK/Cairo) and Chromium without GPU should be fine under Xvfb; the smoke test finds problems fast [I].
2. Kernel 7.0 hosts are untested by Firecracker upstream [D]; mitigated by pinning a 6.x kernel on production hosts.
3. Nested KVM unusable on this dev box [C]; all guest tests run on the laptop or a metal host.
4. Boot time and resume time for the full desktop are unmeasured [U].
5. Memory per active user is unmeasured [U].
6. `iptables-legacy` in `isolation-guard` vs nftables-backed Docker on Ubuntu 26 [C: repo; I: effect]. Fix by switching the guard to the backend `docker info` reports.

---

## 9. Migration plan (single engineer, calendar days of focused work)

| Step | Work | Days | Done when |
|---|---|---|---|
| P0 | Laptop readiness: BIOS, groups, `check-kvm.sh --probe`, `fc-install.sh` | 0.5 | check script exits 0 |
| P1 | **Boot our rootfs**: `fc-build-rootfs.sh`, `fc-smoke.sh`; fix image gaps (userns, shm, missing libs) | 1.5 | `RESULT: PASS`; boot time recorded |
| P2 | **vsock guest agent** + host bridge (exec, files, ping, shutdown); frame limits | 3 | `exec` and file round-trip over vsock with no network device |
| P3 | Desktop over vsock: x11vnc rw/ro on vsock bridges, noVNC through `fcd`, lease/epoch check | 3 | take-control works in the browser; RO viewer cannot send input |
| P4 | Taps + nft: routed /30 per VM, default deny, DNS resolver, Docker `DOCKER-USER` integration | 3 | N1-N10 network tests pass |
| P5 | Jailer + cgroup v2 limits + per-VM uid + `--new-pid-ns` | 2 | E4/E5 tests pass |
| P6 | `fcd` + `Compute.Firecracker` provider; run `tests/compute-contract` against it | 6 | contract suite green; RSS per active desktop measured |
| P7 | Disk model (RO `vda` + per-user `vdb` + overlay), image pipeline in CI, our own guest kernel | 3 | recreate keeps `/home`; image build reproducible |
| P8 | Idle-stop, pause/resume, memory snapshot, warm template with reseed | 3 | S1-S4 snapshot tests pass |
| P9 | Per-bot isolation inside the VM re-validated; guard/test updates | 2 | existing per-bot tests pass inside a microVM |
| P10 | Test automation: escape + cross-VM suites in CI on a KVM runner | 4 | suites run unattended |
| P11 | Production host (Hetzner AX or AWS metal): systemd units, SMT/mitigations, monitoring, runbook, cut over, remove Docker-provider isolation hacks | 3 | canary users on microVMs for a week |
| | **Total** | **about 33** | |

Order rationale: P1 de-risks the image, P2 de-risks the control path, P6 de-risks the integration. Run P4 before P6 so the provider is never tested without egress policy.

---

## 10. Test plan

Run automatically on every build on a KVM host (laptop first). Attacker model: **root inside the guest**.

### 10.1 Escape tests (guest to host)

| # | Test | Pass |
|---|---|---|
| E1 | Inside the guest, list devices; open `/dev/mem`, `/dev/kmem`, `/dev/port` | absent or EPERM; only virtio devices |
| E2 | On the host, inspect the Firecracker process: `/proc/<pid>/status` | uid is the per-VM uid (not 0), `CapEff` zero, `NoNewPrivs: 1`, `Seccomp: 2` |
| E3 | `ls /proc/<pid>/root/` | only `vmlinux`, drives, sockets, `dev/kvm`, `dev/net/tun` |
| E4 | Guest connects vsock to CID 2 on every port 1-65535 | only the intended ports answer; no connection to another VM's socket |
| E5 | Fuzz the vsock bridge: oversized frames, truncated frames, slow-loris | bridge closes, host RSS stable, other VMs unaffected |
| E6 | Guest memory bomb | the VMM's cgroup OOMs only that VM; host and others fine |
| E7 | Guest fork bomb / CPU burn | `pids.max` and `cpu.max` contain it |
| E8 | Serial console and agent log flood | log rotated, disk quota holds |
| E9 | Disk fill in `vdb` | quota stops at the sparse file size; host disk unaffected |
| E10 | Snapshot and disk file permissions | 0600, owned by `fcd` or the VM uid only |
| E11 | Re-run published Firecracker advisories' PoCs relevant to our version | none succeed (and subscribe to the security advisories) |

### 10.2 Cross-VM and network tests

| # | Test | Pass |
|---|---|---|
| N1 | VM A pings and TCP-connects to VM B (both /30 gateways and guest IPs) | dropped |
| N2 | VM A scans the host: 22, 8080, 5432, 2375, docker0 and bridge IPs | everything dropped except DNS to `10.200.0.1:53` |
| N3 | VM A to RFC1918, link-local (169.254.169.254), laptop LAN | dropped |
| N4 | VM A spoofs another VM's source IP; forged ARP/MAC | dropped; no L2 shared |
| N5 | IPv6 RA / traffic | none leaves the guest |
| N6 | Allow-all egress to the public internet (HTTPS) | works |
| N7 | Allowlist mode | only listed domains and their resolved IPs pass |
| N8 | DNS tunnel burst | rate limit holds |
| N9 | `systemctl restart docker`, then repeat N1-N3 | still dropped (rules survive; this exercises the legacy-vs-nft guard issue) |
| N10 | Delete a VM, then list taps, nft sets, cgroups, chroots, uids | nothing left behind |

### 10.3 Lifecycle, lease, snapshot

- **L1** stale-epoch client is refused by `fcd`; resume after pause bumps the epoch.
- **L2** two simultaneous RW viewers: second refused; RO viewer never sends input.
- **L3** `fcd` kill -9 then restart: reconciliation finds all VMs; nothing orphaned.
- **S1** restore the same snapshot twice, the second after `reseed`: distinct `/proc/sys/kernel/random/boot_id`, different generated keys.
- **S2** clock after resume within 1 s of the host.
- **S3** network works after restore (tap recreated, rules reapplied).
- **S4** restore a snapshot with a different `vdb`: refused.
- **X1** noisy neighbour: CPU and memory stress in VM A; Xvfb frame latency in VM B stays within 20% of baseline.
- **C1** the full `tests/compute-contract/Scenarios.cs` suite passes against `Compute.Firecracker`.

### 10.4 Release gate

All of E1-E11, N1-N10, L1-L3, S1-S4, C1 pass on the production host type (not only the laptop), and one 24-hour soak with 10 active VMs shows no leaked taps, cgroups or memory growth.

---

## 11. First prototype: what to build first

1. Run `scripts/check-kvm.sh --probe`, `fc-install.sh`, `fc-build-rootfs.sh`, `fc-smoke.sh` on the laptop. Paste the output back; fix the image (P1).
2. Write `services/fcd` skeleton with `POST /vms` + `start` + `exec` over vsock (P2 core). Add a Python guest agent as an s6 service.
3. Put noVNC in front of vsock 5001/5002 (P3). That demonstrates the whole value: **a user's desktop in a microVM with no guest network at all.**
4. Then P4 (network policy) and P6 (provider and contract tests).

---

## 12. Sources

Firecracker
- Design / threat containment: https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md
- Jailer: https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md
- Seccomp: https://github.com/firecracker-microvm/firecracker/blob/main/docs/seccomp.md
- Network setup (TAP, nft recommended, no filtering): https://github.com/firecracker-microvm/firecracker/blob/main/docs/network-setup.md
- vsock: https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md
- Snapshots: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
- Production host setup: https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md
- Ballooning: https://github.com/firecracker-microvm/firecracker/blob/main/docs/ballooning.md
- Getting started / rootfs and kernel: https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md, https://github.com/firecracker-microvm/firecracker/blob/main/docs/rootfs-and-kernel-setup.md
- Releases (v1.17.0, sha256 files): https://github.com/firecracker-microvm/firecracker/releases
- NSDI'20 paper "Firecracker: Lightweight Virtualization for Serverless Applications": https://www.usenix.org/conference/nsdi20/presentation/agache

Grok Bot
- Teams and Enterprise (Firecracker per-user isolation, Network Controls): https://cursor.com/docs/grok-bot/teams
- Security (network policy, static egress): https://cursor.com/docs/grok-bot/security
- Security FAQ: https://cursor.com/docs/grok-bot/security-faq

Host platform
- Ubuntu 26.04 LTS release notes: https://documentation.ubuntu.com/release-notes/26.04/
- Ubuntu nftables (iptables-nft default): https://documentation.ubuntu.com/security/security-features/network/firewall/nftables/
- cgroup v2 only on 26.04: https://computingforgeeks.com/ubuntu-2604-cgroup-v2-migration/ (secondary)
- Kernel 7.0 / Docker 29 nftables backend claim: https://mondoo.com/blog/whats-new-in-ubuntu-2604-security (secondary)
- Docker packet filtering (FORWARD drop, DOCKER-USER, nftables experimental, `ip-forward-no-drop`): https://docs.docker.com/engine/network/packet-filtering-firewalls/

Fallbacks and prices
- gVisor platforms (systrap default, KVM platform): https://gvisor.dev/docs/user_guide/platforms/
- Kata hypervisors: https://github.com/kata-containers/kata-containers/blob/main/docs/hypervisors.md
- Cloud Hypervisor: https://github.com/cloud-hypervisor/cloud-hypervisor
- AWS EC2 nested virtualization on virtual instances (2026 announcements) and pricing: https://aws.amazon.com/ec2/pricing/on-demand/
- Hetzner dedicated AX42 / AX102: https://www.hetzner.com/dedicated-rootserver/ax42/ , https://www.hetzner.com/dedicated-rootserver/ax102/

Internal
- `BOT_COMPUTER_ARCHITECTURE.md` §10, §14, §16
- Repo: `src/Compute.Domain/ComputeModel.cs`, `src/Compute.Docker/DockerComputeProvider.cs`, `src/services/computer/Dockerfile`, `src/docker-compose.yml`, `src/deploy/computer-isolation.sh`, `src/deploy/isolation-guard/`, `src/tests/compute-contract/Scenarios.cs`
