import Link from "next/link";
import { StatusScreen } from "@/components/status-screen";

export default function NotFound() {
  return (
    <StatusScreen
      testId="not-found-page"
      code="404"
      title="That page is not here"
      detail="The address does not match a screen in Teammates."
      action={
        <Link href="/" className="inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground">
          Back to teammates
        </Link>
      }
    />
  );
}
