import { SharedPage } from "@/components/page-canvas";
export const metadata = { title: "Shared page", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedPage token={token} />;
}
