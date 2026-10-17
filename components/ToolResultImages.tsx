"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { imageSource, resultImageFileName } from "@/lib/result-image";
import type { ImageContent } from "@/lib/types";
import { ImagePreview } from "./ImagePreview";

function imageMediaType(image: ImageContent): string | undefined {
  return image.source?.media_type ?? (image as unknown as { mimeType?: string }).mimeType;
}

export function ResultImage({ image, index }: { image: ImageContent; index: number }) {
  const { t } = useI18n();
  const src = imageSource(image);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const failed = !src || failedSource === src;
  const alt = t("chat.resultImageLabel", { number: index + 1 });

  return (
    <div className="result-image">
      {failed ? (
        <div className="result-image-failure" role="status">
          {t("chat.imageLoadFailed")}
          {src && <button type="button" onClick={() => { setFailedSource(null); setAttempt((value) => value + 1); }}>{t("common.retry")}</button>}
        </div>
      ) : (
        <ImagePreview src={src} alt={alt} className="result-image-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={`${src.startsWith("data:") ? "inline" : src}:${attempt}`} src={src} alt={alt} loading="lazy" onError={() => setFailedSource(src)} />
        </ImagePreview>
      )}
      <button
        type="button"
        className="result-image-save"
        disabled={!src || saving}
        onClick={async () => {
          setSaving(true);
          setSaveFailed(false);
          try {
            const { downloadUrlAsFile } = await import("@/lib/desktop-native");
            await downloadUrlAsFile(src, resultImageFileName(imageMediaType(image), index));
          } catch {
            setSaveFailed(true);
          } finally {
            setSaving(false);
          }
        }}
      >
        {t("chat.saveImage")}
      </button>
      {saveFailed && <div className="result-image-failure" role="alert">{t("chat.imageSaveFailed")}</div>}
    </div>
  );
}

/** Ordinary tool images keep their existing inline fallback outside a managed turn. */
export function ToolResultImages({ images, isError }: { images: ImageContent[]; isError: boolean }) {
  return (
    <div className="tool-result-images" data-error={isError || undefined}>
      {images.map((image, index) => <ResultImage key={index} image={image} index={index} />)}
    </div>
  );
}
