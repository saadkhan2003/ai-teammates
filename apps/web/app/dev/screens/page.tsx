"use client";

import dynamic from "next/dynamic";

// The gallery is available in production for visual checks, but its complete
// screen catalog is a separate chunk rather than part of the first load.
const ScreenGallery = dynamic(() => import("@/components/screen-gallery"), { ssr: false });
export default function ScreenGalleryPage() { return <ScreenGallery />; }
