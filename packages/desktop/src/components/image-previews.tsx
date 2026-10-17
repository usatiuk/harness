import type { ImageContent } from "@harness/protocol";
import { Dialog } from "../ui.tsx";

export function ImagePreviews({
  images,
  onRemove,
}: {
  images: readonly ImageContent[];
  onRemove?: (index: number) => void;
}) {
  return (
    <div className="image-previews">
      {images.map((image, index) => {
        const src = `data:${image.mediaType};base64,${image.data}`;
        return (
          <div className="image-preview" key={index}>
            <Dialog.Root>
              <Dialog.Trigger asChild>
                <button
                  type="button"
                  className="image-preview-open"
                  aria-label={`Open image ${index + 1}`}
                >
                  <img src={src} alt={`Attachment ${index + 1}`} />
                </button>
              </Dialog.Trigger>
              <Dialog.Content className="image-viewer" maxWidth="none" aria-describedby={undefined}>
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
