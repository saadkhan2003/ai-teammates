export function RouteLoading({ kind = "content" }: { kind?: "content" | "form" | "table" }) {
  const block = "animate-pulse rounded-md bg-primary/10";
  return <main role="status" aria-busy="true" className="space-y-5 p-4 sm:p-6"><span className="sr-only">Loading admin page</span><div className={`${block} h-8 w-48`} /><div className={`${block} h-4 w-72 max-w-full`} /><div className="space-y-3 rounded-md border border-border p-4">{Array.from({ length: kind === "table" ? 7 : kind === "form" ? 5 : 3 }, (_, i) => <div key={i} className={`${block} h-10 w-full`} />)}</div></main>;
}
