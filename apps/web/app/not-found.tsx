import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid h-full place-items-center px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card px-6 py-8 text-center">
        <p className="text-body-sm font-medium">That page is not here</p>
        <p className="mt-2 text-body-sm text-muted-foreground">The address does not match a screen in Teammates.</p>
        <Link href="/" className="mt-4 inline-flex h-9 items-center rounded-md bg-primary px-3 text-body-sm text-primary-foreground">
          Back to teammates
        </Link>
      </div>
    </div>
  );
}
