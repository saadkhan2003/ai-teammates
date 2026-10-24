import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-primary/10 motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

/** Rows of placeholder lines for a list that is still loading. The label is read by screen readers. */
function ListSkeleton({ label, rows = 3, className, testId }: { label: string; rows?: number; className?: string; testId?: string }) {
  return (
    <div role="status" aria-busy="true" data-testid={testId ?? "list-skeleton"} className={cn("space-y-2 py-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2" aria-hidden="true">
          <Skeleton className="h-9 w-9 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** Chat-shaped placeholder: a few bubbles on both sides, plus a composer bar. */
function ChatSkeleton() {
  return (
    <div role="status" aria-busy="true" data-testid="chat-skeleton" className="flex h-full min-h-0 flex-col">
      <span className="sr-only">Loading the conversation</span>
      <div className="flex h-12 items-center justify-center border-b border-border" aria-hidden="true">
        <Skeleton className="h-7 w-36 rounded-full" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4" aria-hidden="true">
        <Skeleton className="h-14 w-3/5 rounded-2xl" />
        <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
        <Skeleton className="h-20 w-4/5 rounded-2xl" />
      </div>
      <div className="mx-auto w-full max-w-3xl p-4" aria-hidden="true">
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  )
}

export { Skeleton, ListSkeleton, ChatSkeleton }
