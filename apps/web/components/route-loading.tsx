import { ChatSkeleton, Skeleton } from "@/components/ui/skeleton";

export function RouteLoading({ kind = "content" }: { kind?: "content" | "chat" | "form" | "table" }) {
  if (kind === "chat") return <div className="h-full min-h-0"><ChatSkeleton /></div>;
  if (kind === "form") return <main role="status" aria-busy="true" className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6"><span className="sr-only">Loading page</span><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-72 max-w-full" /><div className="space-y-4 rounded-md border border-border p-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div></main>;
  if (kind === "table") return <main role="status" aria-busy="true" className="space-y-5 p-4 sm:p-6"><span className="sr-only">Loading page</span><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-72 max-w-full" /><div className="space-y-3 rounded-md border border-border p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div></main>;
  return <main role="status" aria-busy="true" className="space-y-5 p-4 sm:p-6"><span className="sr-only">Loading page</span><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-72 max-w-full" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div><Skeleton className="h-64 w-full" /></main>;
}
