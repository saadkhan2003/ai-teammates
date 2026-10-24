import Link from "next/link";

export default function AdminSettingsPage() {
  return <section data-testid="platform-form" className="rounded-[8px] border border-border bg-card p-4">
    <h2 className="text-xl font-semibold">Settings</h2>
    <p className="mt-3 text-sm text-muted-foreground">Manage providers, model roles, caching and credit prices in <Link className="underline" href="/ai-models">AI models</Link>. Use the theme controls above to change appearance.</p>
    <p className="mt-3 text-sm text-muted-foreground">This deployment has no account billing or monthly credit grants. Model calls use the default plan price map.</p>
  </section>;
}
