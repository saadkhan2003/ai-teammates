"use client";

import { useEffect, useState, type ReactNode } from "react";
import { loadBrandIcon, type BrandIcon } from "@/lib/brand-icons";
import { appHue } from "@/lib/connect-apps";
import { cn } from "@/lib/utils";

function logoTone(hex: string) {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) return "light";
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.22 ? "dark" : "light";
}

export function AppLogo({
  name,
  iconUrl = "",
  size = 36,
  shape = "square",
  className,
}: {
  name: string;
  iconUrl?: string;
  size?: number;
  shape?: "square" | "circle";
  className?: string;
}) {
  const [remoteFailed, setRemoteFailed] = useState(false);
  const [brand, setBrand] = useState<BrandIcon | null | undefined>(undefined);
  const rounded = shape === "circle" ? "rounded-full" : "rounded-lg";
  // Keep the ring on an overflow-visible frame. A circle mask on that same
  // element clips both the ring and the corners of the brand mark.
  const glyph = Math.round(size * (shape === "circle" ? 0.66 : 0.62));
  const frame = (logo: string, tone: string | undefined, inner: ReactNode) => (
    <span
      data-testid="app-logo"
      data-logo={logo}
      data-logo-tone={tone}
      className={cn("relative grid shrink-0 place-items-center overflow-visible", className)}
      style={{ width: size, height: size }}
    >
      {inner}
    </span>
  );

  useEffect(() => {
    let live = true;
    setBrand(undefined);
    void loadBrandIcon(name).then((icon) => {
      if (live) setBrand(icon);
    });
    return () => {
      live = false;
    };
  }, [name]);

  if (iconUrl && !remoteFailed) {
    return frame(
      "remote",
      undefined,
      <span className={cn("grid place-items-center bg-white", rounded)} style={{ width: size, height: size }}>
        <img
          src={iconUrl}
          alt=""
          width={glyph}
          height={glyph}
          className="object-contain"
          style={{ width: glyph, height: glyph }}
          onError={() => setRemoteFailed(true)}
        />
      </span>,
    );
  }

  if (brand) {
    const tone = logoTone(brand.hex);
    return frame(
      "brand",
      tone,
      <span className={cn("grid place-items-center bg-white", rounded, tone === "dark" && shape !== "circle" && "logo-dark-tile")} style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" width={glyph} height={glyph} aria-hidden>
          <path d={brand.path} fill={`#${brand.hex}`} />
        </svg>
      </span>,
    );
  }

  if (brand === undefined && !remoteFailed) {
    return frame("loading", undefined, <span className={cn("animate-pulse bg-muted", rounded)} style={{ width: size, height: size }} />);
  }

  const letter = name.trim().charAt(0).toUpperCase() || "A";
  const hue = appHue(name || letter);
  return (
    <span
      data-testid="app-logo"
      data-logo="letter"
      className={cn("grid shrink-0 place-items-center text-micro font-semibold text-white", rounded, className)}
      style={{ width: size, height: size, background: `linear-gradient(145deg, hsl(${hue} 62% 48%), hsl(${(hue + 28) % 360} 55% 34%))` }}
      aria-hidden
    >
      {letter}
    </span>
  );
}
