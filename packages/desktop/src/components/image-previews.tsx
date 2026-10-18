import type { ImageContent } from "@harness/protocol";
import { useState } from "react";
import { Dialog } from "../ui.tsx";

export function ImagePreviews({
  images,
  onRemove,
}: {
  images: readonly ImageContent[];
  onRemove?: (index: number) => void;
}) {
  const [openImage, setOpenImage] = useState<number | null>(null);
  return (
    <div className="image-previews">
      {images.map((image, index) => {
        const src = `data:${image.mediaType};base64,${image.data}`;
        return (
          <div className="image-preview" key={index}>
            <Dialog.Root
              open={openImage === index}
              onOpenChange={(open) => setOpenImage(open ? index : null)}
            >
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  className="image-preview-open"
                  aria-label={`Open image ${index + 1}`}
                >
                  <img src={src} alt={`Attachment ${index + 1}`} />
                </button>
              </Dialog.Trigger>
              <Dialog.Content
                className="image-viewer"
                maxWidth="none"
                aria-describedby={undefined}
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  // Keep Escape on the viewer instead of a focused button's tooltip.
                  (event.currentTarget as HTMLElement).focus();
                }}
                onKeyDown={(event) => {
                  // Dismiss before a close-button tooltip can consume Escape.
                  if (event.key === "Escape") setOpenImage(null);
                }}
                onClick={(event) => {
                  if (event.target === event.currentTarget) setOpenImage(null);
                }}
              >
                <Dialog.Title className="sr-only">Image {index + 1}</Dialog.Title>
                <img src={src} alt={`Attachment ${index + 1}`} />
              </Dialog.Content>
            </Dialog.Root>
            {onRemove && (
              <button
                type="button"
                className="image-preview-remove"
                aria-label={`Remove image ${index + 1}`}
                onClick={() => onRemove(index)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
