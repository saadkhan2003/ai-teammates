"use client";

import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type GalleryImage = { src: string; alt: string };

export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: GalleryImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const current = images[index];
  const stripRef = useRef<HTMLDivElement>(null);
  const startX = useRef<number | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") onIndex(Math.min(images.length - 1, index + 1));
      if (event.key === "ArrowLeft") onIndex(Math.max(0, index - 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, index, onClose, onIndex]);

  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [index]);

  if (!current || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-testid="image-lightbox"
      className="image-lightbox fixed inset-0 z-[80] flex items-center justify-center bg-black/90 p-6 text-white"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute right-4 top-4 flex items-center gap-2">
        <a
          data-testid="lightbox-download"
          href={current.src}
          download
          aria-label={`Download ${current.alt || "image"}`}
          className="grid size-9 place-items-center rounded-full bg-neutral-900 text-white shadow-md hover:bg-neutral-800"
        >
          <Download className="size-4" strokeWidth={1.5} />
        </a>
        <button
          type="button"
          data-testid="lightbox-close"
          aria-label="Close"
          className="grid size-9 place-items-center rounded-full bg-neutral-900 text-white shadow-md hover:bg-neutral-800"
          onClick={onClose}
        >
          <X className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      {index > 0 ? (
        <button
          type="button"
          data-testid="lightbox-prev"
          aria-label="Previous image"
          className="absolute left-4 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-neutral-900 text-white hover:bg-neutral-800"
          onClick={() => onIndex(index - 1)}
        >
          <ChevronLeft className="size-5" />
        </button>
      ) : null}
      {index < images.length - 1 ? (
        <button
          type="button"
          data-testid="lightbox-next"
          aria-label="Next image"
          className="absolute right-4 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-neutral-900 text-white hover:bg-neutral-800"
          onClick={() => onIndex(index + 1)}
        >
          <ChevronRight className="size-5" />
        </button>
      ) : null}
      <div
        className="flex max-h-full max-w-[80vw] flex-col items-center"
        onTouchStart={(event) => {
          startX.current = event.changedTouches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          const start = startX.current;
          const end = event.changedTouches[0]?.clientX;
          startX.current = null;
          if (start == null || end == null) return;
          const delta = end - start;
          if (delta < -40) onIndex(Math.min(images.length - 1, index + 1));
          if (delta > 40) onIndex(Math.max(0, index - 1));
        }}
      >
        <img
          data-testid="lightbox-image"
          src={current.src}
          alt={current.alt}
          className="image-lightbox-frame h-auto w-auto max-h-[75vh] max-w-[80vw] rounded-xl bg-black object-contain opacity-100 shadow-[0_16px_50px_rgb(0_0_0_/_0.45)]"
        />
        <p data-testid="lightbox-caption" className="mt-3 text-center text-body-sm text-white">
          {current.alt ? <span>{current.alt}</span> : null}
          {current.alt ? <span className="px-1.5 text-white/50">·</span> : null}
          <span data-testid="lightbox-count" className="text-white/60">
            {index + 1} / {images.length}
          </span>
        </p>
        {images.length > 1 ? (
          <div ref={stripRef} data-testid="lightbox-thumbs" className="mt-4 flex max-w-[80vw] gap-2 overflow-x-auto px-1 py-1">
            {images.map((image, item) => (
              <button
                key={`${image.src}-${item}`}
                type="button"
                data-testid="lightbox-thumb"
                data-active={item === index ? "true" : "false"}
                aria-label={image.alt || `Image ${item + 1}`}
                className={cn("h-10 w-14 shrink-0 overflow-hidden rounded-lg", item === index ? "ring-2 ring-white" : "opacity-50")}
                onClick={() => onIndex(item)}
              >
                <img src={image.src} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

