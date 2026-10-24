#!/usr/bin/env bash
# Fail when npm, NuGet, or pip reports any known vulnerability (low and above).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for the dependency audit" >&2
  exit 1
fi

audit_npm() {
  local dir="$1"
  echo "npm audit ${dir}"
  (cd "$dir" && npm audit --audit-level=low)
}

audit_npm apps/web
audit_npm tests/e2e

if ! command -v dotnet >/dev/null 2>&1; then
  echo "dotnet is required for the dependency audit" >&2
  exit 1
fi

dotnet_projects=(
  apps/api/Teammates.Api.csproj
  src/Compute.Docker/Compute.Docker.csproj
  src/Compute.Domain/Compute.Domain.csproj
  src/Compute.Fake/Compute.Fake.csproj
  contracts/csharp/Compute.Contracts.csproj
  tests/unit/Teammates.UnitTests.csproj
  tests/compute-contract/Compute.ContractTests.csproj
)

dotnet_failed=0
for project in "${dotnet_projects[@]}"; do
  echo "dotnet vulnerable ${project}"
  output="$(dotnet list "$project" package --vulnerable --include-transitive)"
  printf '%s\n' "$output"
  if ! grep -q "has no vulnerable packages" <<<"$output"; then
    echo "vulnerable NuGet packages in ${project}" >&2
    dotnet_failed=1
  fi
done
if [[ "$dotnet_failed" -ne 0 ]]; then
  exit 1
fi

python3 -m pip install --user --disable-pip-version-check -q pip-audit
export PATH="${HOME}/.local/bin:${PATH}"

pip_requirements=(
  services/agent/requirements.txt
  services/computer/requirements.txt
  requirements-dev.txt
)
for req in "${pip_requirements[@]}"; do
  echo "pip-audit ${req}"
  python3 -m pip_audit --requirement "$req" --progress-spinner off
done
