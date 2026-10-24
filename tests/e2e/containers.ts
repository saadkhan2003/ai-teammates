// Container names for specs that shell out to docker. Every name derives from
// the compose project under test so a run against an isolated test stack can
// never exec into, restart or query the live `teammates` stack.
const projects = [...new Set([process.env.E2E_COMPOSE_PROJECT, process.env.COMPOSE_PROJECT, process.env.STACK, process.env.COMPUTE_STACK].filter(Boolean))];
if (projects.length !== 1 || projects[0] === "teammates") {
  throw new Error("Set STACK or E2E_COMPOSE_PROJECT to one consistent isolated stack name");
}
const project = projects[0]!;
process.env.STACK = project;
if (!process.env.BASE_URL) throw new Error("BASE_URL is required for e2e tests");

export const COMPOSE_PROJECT = project;
export const PG_CONTAINER = process.env.PG_CONTAINER ?? `${project}-postgres-1`;
export const AGENT_CONTAINER = process.env.AGENT_CONTAINER ?? `${project}-agent-1`;
export const API_CONTAINER = process.env.API_CONTAINER ?? `${project}-api-1`;
export const MOCK_CONTAINER = process.env.MOCK_CONTAINER ?? `${project}-mock-openrouter-1`;
