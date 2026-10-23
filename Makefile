.PHONY: install up test test-unit test-contract test-integration test-e2e test-desktop-speed test-lowend eval-real

NODE_BIN := $(shell ls -d /home/ubuntu/.nvm/versions/node/*/bin 2>/dev/null | tail -1)
export PATH := $(NODE_BIN):/home/ubuntu/.dotnet:$(PATH)
export PYTHONPATH := /home/ubuntu/.local/lib/python3.12/site-packages$(if $(PYTHONPATH),:$(PYTHONPATH),)
export PLAYWRIGHT_BROWSERS_PATH := /home/ubuntu/.cache/ms-playwright
export DOTNET_CLI_TELEMETRY_OPTOUT := 1

install:
	bash scripts/install.sh

up:
	sudo iptables-legacy -P FORWARD ACCEPT || true
	sudo docker compose up -d --build
	sudo bash deploy/computer-isolation.sh

test-unit:
	dotnet test tests/unit/Teammates.UnitTests.csproj --nologo
	python3 -m pytest -q tests/unit

test-contract:
	dotnet test tests/compute-contract/Compute.ContractTests.csproj --nologo
	sudo env PATH="$$PATH" COMPUTE_CONTRACT_DOCKER=1 DOCKER_HOST=unix:///var/run/docker.sock SECCOMP_PROFILE=/workspace/deploy/seccomp-chrome.json COMPUTE_IMAGE=teammates-computer:dev dotnet test tests/compute-contract/Compute.ContractTests.csproj --nologo

test-integration:
	sudo docker compose -f docker-compose.yml -f deploy/compose.test.yml up -d api caddy
	i=0; until curl -fsS http://127.0.0.1:18081/health >/dev/null && curl -fsS http://127.0.0.1:18080/health >/dev/null; do i=$$((i+1)); if [ $$i -gt 90 ]; then echo "api did not become reachable"; exit 1; fi; sleep 1; done
	API_URL=$${API_URL:-http://127.0.0.1:18081} python3 -m pytest -q tests/integration

test-e2e:
	cd tests/e2e && npm install && npx playwright test

test-desktop-speed:
	node tests/perf/desktop-speed.mjs

test: test-unit test-contract test-integration test-e2e

test-lowend:
	bash scripts/low-end.sh
	$(MAKE) test

eval-real:
	python3 evals/eval_real.py
