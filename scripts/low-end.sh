#!/bin/bash
# Run the stack inside a 4 GiB / 2 CPU cgroup. Compose service caps already
# match this budget. This script also tightens a computer that was created
# on an older quota (640 MB, 0.40 CPU, no extra swap).
set -euo pipefail
cd "$(dirname "$0")/.."
STACK="${STACK:?STACK is required}"

PARENT=/sys/fs/cgroup/teammates-lowend
if [[ -f /sys/fs/cgroup/cgroup.controllers ]]; then
  echo "+memory +cpu +pids" | sudo tee /sys/fs/cgroup/cgroup.subtree_control >/dev/null || true
  sudo mkdir -p "$PARENT"
  echo $((4 * 1024 * 1024 * 1024)) | sudo tee "$PARENT/memory.max" >/dev/null
  # 2 CPUs: 200000 µs of quota per 100000 µs period.
  echo "200000 100000" | sudo tee "$PARENT/cpu.max" >/dev/null
  echo "max" | sudo tee "$PARENT/pids.max" >/dev/null || true
fi

sudo MAX_COMPUTERS=2 CGROUP_PARENT=/teammates-lowend \
  docker compose -p "$STACK" --profile lowend -f docker-compose.yml -f deploy/compose.low-end.yml up -d "$@"
for id in $(sudo docker ps -q --filter label=teammates.managed=1 --filter "label=com.docker.compose.project=$STACK"); do
  sudo docker update --memory 640m --memory-swap 640m --cpus 0.40 "$id" || true
done
echo "low-end caps applied"
