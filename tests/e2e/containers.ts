// Container names for specs that shell out to docker. Every name derives from
// the compose project under test so a run against an isolated test stack can
// never exec into, restart or query the live `teammates` stack.
const project = process.env.E2E_COMPOSE_PROJECT ?? "teammates";
const base = process.env.BASE_URL ?? "http://127.0.0.1:18080";

if (project === "teammates" && !/:18080(\/|$)/.test(base)) {
  throw new Error(
    `BASE_URL ${base} is not the default stack but E2E_COMPOSE_PROJECT is unset; ` +
      "set E2E_COMPOSE_PROJECT to the compose project under test",
  );
}

export const COMPOSE_PROJECT = project;
export const PG_CONTAINER = process.env.PG_CONTAINER ?? `${project}-postgres-1`;
export const AGENT_CONTAINER = process.env.AGENT_CONTAINER ?? `${project}-agent-1`;
export const API_CONTAINER = process.env.API_CONTAINER ?? `${project}-api-1`;
export const MOCK_CONTAINER = process.env.MOCK_CONTAINER ?? `${project}-mock-openrouter-1`;
