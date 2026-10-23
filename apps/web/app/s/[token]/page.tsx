import type { Metadata } from "next";
import { SharedLibraryPreview } from "@/components/shared-library-preview";

export const metadata: Metadata = {
  title: "Shared library item",
  robots: { index: false, follow: false },
};

export default async function SharedLibraryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <main className="mx-auto min-h-screen max-w-3xl p-4 pt-12 md:p-10"><SharedLibraryPreview token={token} /></main>;
}
