.PHONY: install up test test-unit test-contract test-integration test-e2e test-desktop-speed test-lowend eval-real contract-check

NODE_BIN := $(shell ls -d /home/ubuntu/.nvm/versions/node/*/bin 2>/dev/null | tail -1)
export PATH := /workspace/dotnet:$(NODE_BIN):/home/ubuntu/.dotnet:$(PATH)
export PYTHONPATH := /home/ubuntu/.local/lib/python3.12/site-packages$(if $(PYTHONPATH),:$(PYTHONPATH),)
export PLAYWRIGHT_BROWSERS_PATH := /home/ubuntu/.cache/ms-playwright
export DOTNET_CLI_TELEMETRY_OPTOUT := 1

install:
	bash scripts/install.sh

up:
	@test -n "$$STACK" || { echo "STACK is required" >&2; exit 2; }
	sudo iptables-legacy -P FORWARD ACCEPT || true
	sudo docker compose -p "$$STACK" up -d --build
	sudo bash deploy/computer-isolation.sh

test-unit:
	dotnet test tests/unit/Teammates.UnitTests.csproj --nologo
	python3 -m pytest -q tests/unit
	cd apps/web && npm ci && node --test lib/chat-ui.test.mjs

test-contract:
	dotnet test tests/compute-contract/Compute.ContractTests.csproj --nologo
	sudo env PATH="$$PATH" COMPUTE_CONTRACT_DOCKER=1 DOCKER_HOST=unix:///var/run/docker.sock SECCOMP_PROFILE=/workspace/deploy/seccomp-chrome.json COMPUTE_IMAGE=teammates-computer:dev dotnet test tests/compute-contract/Compute.ContractTests.csproj --nologo

test-integration:
	@test -n "$$STACK" || { echo "STACK is required" >&2; exit 2; }
	@test -n "$$BASE_URL" || { echo "BASE_URL is required" >&2; exit 2; }
	@test -n "$$API_URL" || { echo "API_URL is required" >&2; exit 2; }
	sudo docker compose -p "$$STACK" -f docker-compose.yml -f deploy/compose.test.yml up -d api caddy
	i=0; until curl -fsS "$$API_URL/health" >/dev/null && curl -fsS "$$BASE_URL/health" >/dev/null; do i=$$((i+1)); if [ $$i -gt 90 ]; then echo "api did not become reachable"; exit 1; fi; sleep 1; done
	STACK="$$STACK" BASE_URL="$$BASE_URL" API_URL="$$API_URL" python3 -m pytest -q tests/integration

test-e2e:
	@test -n "$$STACK" || { echo "STACK is required" >&2; exit 2; }
	@test -n "$$BASE_URL" || { echo "BASE_URL is required" >&2; exit 2; }
	cd tests/e2e && STACK="$$STACK" BASE_URL="$$BASE_URL" npm install && STACK="$$STACK" BASE_URL="$$BASE_URL" npx playwright test

test-desktop-speed:
	node tests/perf/desktop-speed.mjs

test: test-unit test-contract test-integration test-e2e

test-lowend:
	bash scripts/low-end.sh
	$(MAKE) test

eval-real:
	@test -n "$$STACK" || { echo "STACK is required" >&2; exit 2; }
	@test -n "$$BASE_URL" || { echo "BASE_URL is required" >&2; exit 2; }
	STACK="$$STACK" BASE_URL="$$BASE_URL" python3 evals/eval_real.py

contract-check:
	@set -eu; tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; \
	  node scripts/gen-box-contract.mjs --out "$$tmp"; \
	  diff -ru apps/api/BoxContract.g.cs "$$tmp/apps/api/BoxContract.g.cs"; \
	  diff -ru services/computer/src/box_contract.py "$$tmp/services/computer/src/box_contract.py"; \
	  diff -ru services/computer/scripts/box-contract.sh "$$tmp/services/computer/scripts/box-contract.sh"; \
	  diff -ru apps/web/lib/box-contract.ts "$$tmp/apps/web/lib/box-contract.ts"
	node scripts/check-no-port-literals.mjs
	node scripts/gen-box-contract.test.mjs
	python3 -m pytest -q tests/unit/test_box_contract.py
	dotnet test tests/unit/Teammates.UnitTests.csproj --nologo --filter FullyQualifiedName~BoxContractTests
