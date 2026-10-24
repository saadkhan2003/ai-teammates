import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusScreen } from "@/components/status-screen";

export default function ErrorScreenPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <StatusScreen
      testId="error-page"
      code="500"
      title="Something went wrong"
      detail="This screen hit an unexpected error. Try again, or return once the service is back."
      action={
        <Link href="/" className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground">
          Try again
        </Link>
      }
    />
  );
}
