# Repository working context

## Orientation

- Teammates is a self-hosted bot/computer workspace. Read
  `docs/REPOSITORY_GUIDE.md` for the verified architecture, flows, and current gaps.
- ASP.NET Core `net10.0` owns state, policy, secrets, model gateway, and compute.
  Python workers lease tasks and run the model/tool loop. Next.js is the web UI.
- Docker compute runs in the API process. The protobuf service is a future boundary;
  no Go compute host or runtime gRPC service is implemented here.
- Accounts normally share one computer across their bots. Bot shell/file tools use
  separate UIDs/workspace directories; browser/desktop state is account-shared.

## Source boundaries

- `apps/api`: minimal API routes, Dapper queries, runtime, policy/login/plugins.
- `apps/web`: Next.js App Router, React hooks, Tailwind/Radix UI, noVNC.
- `src/Compute.Domain`, `Compute.Docker`, `Compute.Fake`: compute contract and providers.
- `services/agent`: worker, CDP browser tools, output/run guards.
- `services/computer`: desktop container, FastAPI control, filesystem/origin checks.
- `services/mock-openrouter`: deterministic fixtures, not a general-purpose model.
- `db`: numbered SQL migrations; `deploy`/`scripts`: host-integrated operations.

## Conventions

- C# uses file-scoped namespaces, async methods, records, parameterized Dapper SQL.
- PostgreSQL names use snake_case; API responses generally use camelCase.
- Web components use kebab-case filenames, PascalCase exports, shared `@/lib/api`.
- Python uses snake_case and asyncio for worker/browser paths.
- Structured questions and memory notices are persisted as message content JSON.
- Add migrations through both `Platform.MigrateAndSeed` and API Dockerfile copies.
- A new tool can require updates to schema, dispatch, policy, worker routing, and tests.
- `main` is a reconstructed v0.3 baseline; it is not the full product history.
  There are 52 remote branches and later integrated feature work. Read
  `docs/GIT_BRANCH_GUIDE.md` before choosing a branch or treating main as current.

## Build and test entry points

- SDK pin: `global.json` requests `10.0.402`; older feature bands may not resolve it.
- C# unit: `dotnet test tests/unit/Teammates.UnitTests.csproj --nologo`.
- Python unit: `python3 -m pytest -q tests/unit` (pytest and httpx required).
- Fake compute: `dotnet test tests/compute-contract/Compute.ContractTests.csproj --nologo`.
- Web: `cd apps/web && npm ci && npm run build`; dev command is `npm run dev`.
- `make test-contract` also uses real Docker; `make test-integration` alters Compose
  services; `make test-e2e` requires the stack and system Chrome.
- `make eval-real` writes a vault key/bot/tasks and uses a paid provider; it is opt-in.
- CI runs unit/fake compute and proto checks, not the full stack or frontend build.
- Static configuration tests are not runtime proof of isolation or performance.

## Operational facts

- `scripts/install.sh`, `make up`, and low-end scripts change host firewall/cgroups.
- Master key, database, artifact objects, and computer volumes are distinct backup assets.
- The default public edge hides internal worker routes and metrics.
- Docker disk setup includes a temporary privileged helper in the host namespace.
- Several README documentation paths and the desktop-speed script are absent;
  consult the guide's gap table instead of assuming they exist.
