#!/usr/bin/env bash
# Scan shipped container images.
# Fail on any fixable finding.
# Fail on unfixed critical/high except the bot computer image, which still
# needs Debian for chromium, xvfb, s6, and librsvg.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if docker info >/dev/null 2>&1; then
  docker_cmd=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  docker_cmd=(sudo -n docker)
else
  echo "docker is required for the image scan" >&2
  exit 1
fi

if command -v trivy >/dev/null 2>&1; then
  trivy_bin=(trivy)
elif [[ -x /tmp/trivy ]]; then
  trivy_bin=(/tmp/trivy)
else
  echo "trivy is required for the image scan" >&2
  exit 1
fi
# Trivy reads the docker socket. Use the same privilege as the docker client.
if [[ "${docker_cmd[0]}" == "sudo" ]]; then
  trivy_cmd=(sudo -n "${trivy_bin[@]}")
else
  trivy_cmd=("${trivy_bin[@]}")
fi

echo "building teammates-api"
"${docker_cmd[@]}" build -f apps/api/Dockerfile -t teammates-api:scan "$root"
echo "building teammates-web"
"${docker_cmd[@]}" build -f apps/web/Dockerfile -t teammates-web:scan "$root/apps/web"
echo "building teammates-agent"
"${docker_cmd[@]}" build -f services/agent/Dockerfile -t teammates-agent:scan "$root/services/agent"
echo "building teammates-mock"
"${docker_cmd[@]}" build -f services/mock-openrouter/Dockerfile -t teammates-mock:scan "$root/services/mock-openrouter"
echo "building teammates-isolation"
"${docker_cmd[@]}" build -f deploy/isolation-guard/Dockerfile -t teammates-isolation:scan "$root/deploy"

# The computer image is not rebuilt here. Scan the Debian base it still requires.
"${docker_cmd[@]}" pull debian:trixie-slim >/dev/null

scan() {
  local name="$1"
  local image="$2"
  local allow_unfixed="$3"
  local report_dir="$root/.trivy-reports"
  mkdir -p "$report_dir"
  chmod 777 "$report_dir"
  local report="$report_dir/${name}.json"
  rm -f "$report"
  echo "trivy ${name} (${image})"
  if ! "${trivy_cmd[@]}" image --quiet --scanners vuln --severity LOW,MEDIUM,HIGH,CRITICAL --format json --output "$report" "$image"; then
    echo "trivy failed for ${name}" >&2
    return 1
  fi
  python3 - "$report" "$name" "$allow_unfixed" <<'PY'
import json, sys
path, name, allow = sys.argv[1:]
data = json.load(open(path))
counts = {"LOW": 0, "MEDIUM": 0, "HIGH": 0, "CRITICAL": 0}
fixable = 0
unfixed_high = 0
for result in data.get("Results") or []:
    for vuln in result.get("Vulnerabilities") or []:
        severity = vuln.get("Severity", "UNKNOWN")
        counts[severity] = counts.get(severity, 0) + 1
        fixed = bool(vuln.get("FixedVersion"))
        if fixed:
            fixable += 1
        elif severity in ("HIGH", "CRITICAL"):
            unfixed_high += 1
print(f"{name}: low={counts.get('LOW', 0)} medium={counts.get('MEDIUM', 0)} high={counts.get('HIGH', 0)} critical={counts.get('CRITICAL', 0)} fixable={fixable} unfixed_high_or_critical={unfixed_high}")
failed = fixable > 0 or (unfixed_high > 0 and allow != "yes")
sys.exit(1 if failed else 0)
PY
}

failed=0
scan teammates-api teammates-api:scan no || failed=1
scan teammates-web teammates-web:scan no || failed=1
scan teammates-agent teammates-agent:scan no || failed=1
scan teammates-mock teammates-mock:scan no || failed=1
scan teammates-isolation teammates-isolation:scan no || failed=1
scan teammates-computer debian:trixie-slim yes || failed=1

if [[ "$failed" != 0 ]]; then
  echo "image scan failed" >&2
  exit 1
fi
echo "image scan clean"
