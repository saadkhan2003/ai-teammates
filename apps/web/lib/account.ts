export type Identity = {
  provider: string;
  label: string;
  connected: boolean;
  detail: string;
};

export type AccountProfile = {
  id: string;
  username: string;
  role: string;
  status: string;
  displayName: string;
  email: string;
  avatarUrl: string;
  productUpdates: boolean;
  canDelete: boolean;
  identities: Identity[];
};

export type PlanCard = {
  id: string;
  name: string;
  detail: string;
  priceCents: number;
  monthlyCredits: number;
  weeklyCredits?: number;
  features?: string[];
};

export type Invoice = {
  id: string;
  number: string;
  planId: string;
  amountCents: number;
  currency: string;
  status: string;
  provider: string;
  issuedAt: string;
};

export type BillingSnapshot = {
  planId: string;
  creditBalance: number;
  creditAllowance: number;
  usedCredits: number;
  usedPercent: number;
  provider: string;
  chargesCard: boolean;
  mockMode: boolean;
  renewsAt?: string;
  plans: PlanCard[];
  invoices: Invoice[];
};

const planFeatures: Record<string, string[]> = {
  free: ["500 credits each month", "One teammate", "Email help"],
  pro: ["5,000 credits each month", "Daily teammates", "Usage history"],
  team: ["20,000 credits each month", "Shared credit pool", "A workspace for the group"],
};

export function planFeaturesFor(plan: PlanCard) {
  return plan.features?.length ? plan.features : planFeatures[plan.id] ?? [plan.detail];
}

export function formatDay(value?: string) {
  if (!value) return "the first of next month";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "the first of next month";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

export type FaqItem = { id: string; question: string; answer: string };
export type DocLink = { href: string; title: string; detail: string };

export type HelpPayload = { faq: FaqItem[]; docs: DocLink[]; topics: string[] };

export type LegalPayload = { placeholder: boolean; title: string; banner: string; body: string };

export type StatusPayload = {
  indicator: string;
  description: string;
  services: { id: string; name: string; description: string; status: string; days: { date: string; state: string; uptimePercent: number | null; incidents: number }[] }[];
  incidents: { id: string; service: string; title: string; status: string; startedAt: string; resolvedAt?: string | null }[];
};

export type ChangelogPayload = { entries: { id: string; date: string; title: string; body: string }[] };

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "T";
}
