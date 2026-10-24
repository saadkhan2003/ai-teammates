export const WORK_BUDGET_LIMITS = {
  steps: { min: 4, max: 1000 },
  minutes: { min: 1, max: 360 },
} as const;

export function clampWorkBudget(steps: number, minutes: number) {
  return {
    maxSteps: Math.min(WORK_BUDGET_LIMITS.steps.max, Math.max(WORK_BUDGET_LIMITS.steps.min, Math.trunc(steps))),
    maxMinutes: Math.min(WORK_BUDGET_LIMITS.minutes.max, Math.max(WORK_BUDGET_LIMITS.minutes.min, Math.trunc(minutes))),
  };
}

export function formatWorkBudget(steps: number, minutes: number) {
  const value = clampWorkBudget(steps, minutes);
  return `${value.maxSteps} steps · ${value.maxMinutes} min`;
}
