import { shallowRef } from "vue";

type ThumbnailCaptureHandler = () => string | null;

const thumbnailCaptureHandler = shallowRef<ThumbnailCaptureHandler | null>(null);

export function setThumbnailCaptureHandler(
  handler: ThumbnailCaptureHandler | null,
): void {
  thumbnailCaptureHandler.value = handler;
}

export function captureThumbnail(): string | null {
  try {
    return thumbnailCaptureHandler.value?.() ?? null;
  } catch (error) {
    console.error("Failed to capture scene thumbnail:", error);
    return null;
  }
}
