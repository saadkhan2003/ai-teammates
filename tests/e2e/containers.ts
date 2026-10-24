import { spawnSync } from "node:child_process";

// Container names for specs that shell out to docker. Every name derives from
// the compose project under test so a run against an isolated test stack can
// never exec into, restart or query the live `teammates` stack.
const projects = [...new Set([process.env.E2E_COMPOSE_PROJECT, process.env.COMPOSE_PROJECT, process.env.STACK, process.env.COMPUTE_STACK].filter(Boolean))];
if (projects.length !== 1 || projects[0] === "teammates" || !/^[a-z0-9][a-z0-9_-]*$/.test(projects[0]!)) {
  throw new Error("Set STACK or E2E_COMPOSE_PROJECT to one consistent isolated stack name");
}
const project = projects[0]!;
process.env.STACK = project;
if (!process.env.BASE_URL) throw new Error("BASE_URL is required for e2e tests");

export const COMPOSE_PROJECT = project;
function serviceContainer(service: string, override?: string): string {
  const name = override ?? `${project}-${service}-1`;
  if (name === "teammates" || name.startsWith("teammates-")) throw new Error("Live container overrides are forbidden in e2e tests");
  return name;
}
export const PG_CONTAINER = serviceContainer("postgres", process.env.PG_CONTAINER);
export const AGENT_CONTAINER = serviceContainer("agent", process.env.AGENT_CONTAINER);
export const API_CONTAINER = serviceContainer("api", process.env.API_CONTAINER);
export const MOCK_CONTAINER = serviceContainer("mock-openrouter", process.env.MOCK_CONTAINER);

export const COMPUTER_STACK_FILTER = `label=teammates.stack=${project}`;

export function computerContainer(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid computer id");
  const result = spawnSync("sudo", ["-n", "docker", "ps", "-a", "--filter", COMPUTER_STACK_FILTER,
    "--filter", `label=teammates.computer_id=${id}`, "--format", "{{.Names}}"], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error("Unable to resolve computer in isolated stack");
  const names = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (names.length !== 1) throw new Error(`Expected one computer in stack ${project}, found ${names.length}`);
  return names[0]!;
}
