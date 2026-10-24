"use client";

import { FileText } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FileCard } from "@/components/file-card";
import { ImageLightbox, type GalleryImage } from "@/components/image-lightbox";
import { IMAGE_GRID_SINGLE_MAX_HEIGHT, IMAGE_GRID_TILE_HEIGHT, imageGridColumns } from "@/lib/image-grid-layout";
import { cn } from "@/lib/utils";

const IMAGE_GRID_MIN_FALLBACK = 480;

function TileImage({
  image,
  className,
  fit,
  overlay,
  onOpen,
}: {
  image: GalleryImage;
  className: string;
  fit: "cover" | "contain";
  overlay?: ReactNode;
  onOpen: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState(false);
  if (broken) {
    return fit === "contain" ? (
      <div data-testid="image-fallback">
        <FileCard name={image.alt || "Image"} url={image.src} />
      </div>
    ) : (
      <div data-testid="image-fallback" className="grid h-full w-full place-items-center gap-1 rounded-xl border border-border bg-card px-2 text-muted-foreground">
        <FileText className="size-4" aria-hidden />
        <span className="max-w-full truncate text-micro">{image.alt || "File"}</span>
      </div>
    );
  }
  return (
    <button type="button" data-testid="image-tile" className={cn("relative block overflow-hidden bg-muted", className)} onClick={onOpen}>
      {ready ? null : <span data-testid="media-skeleton" className="media-shimmer absolute inset-0 scale-110 blur-md" />}
      <img
        src={image.src}
        alt={image.alt}
        data-fit={fit}
        className={cn(
          "transition-opacity",
          fit === "cover" ? "h-full w-full object-cover" : "h-auto w-auto max-w-full object-contain",
          ready ? "opacity-100" : "opacity-0",
        )}
        style={fit === "contain" ? { maxHeight: IMAGE_GRID_SINGLE_MAX_HEIGHT } : undefined}
        onLoad={() => setReady(true)}
        onError={() => setBroken(true)}
      />
      {overlay}
    </button>
  );
}

export function ImageGrid({ images }: { images: GalleryImage[] }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [images.length]);

  if (images.length === 0) return null;

  const columns = imageGridColumns(width > 0 ? width : IMAGE_GRID_MIN_FALLBACK, images.length);
  const shown = images.slice(0, images.length === 1 ? 1 : columns);
  const extra = images.length - shown.length;

  return (
    <div ref={frame} data-testid="attachment-card" data-image-count={images.length} data-columns={shown.length} className="w-full min-w-0 max-w-full">
      {images.length === 1 ? (
        <TileImage image={images[0]} fit="contain" className="max-w-full rounded-xl" onOpen={() => setOpen(0)} />
      ) : (
        <div
          data-testid="image-strip"
          className="grid w-full gap-1"
          style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))`, height: IMAGE_GRID_TILE_HEIGHT }}
        >
          {shown.map((image, index) => {
            const overflow = extra > 0 && index === shown.length - 1;
            return (
              <TileImage
                key={`${image.src}-${index}`}
                image={image}
                fit="cover"
                className="h-full min-w-0 w-full rounded-xl"
                onOpen={() => setOpen(index)}
                overlay={
                  overflow ? (
                    <span data-testid="image-more" className="absolute inset-0 grid place-items-center rounded-xl bg-black/55 text-title font-semibold text-white">
                      +{extra}
                    </span>
                  ) : null
                }
              />
            );
          })}
        </div>
      )}
      {open != null ? <ImageLightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
