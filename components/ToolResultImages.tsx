"use client";

import { useEffect, useState } from "react";
import { openSessionImageResourceUrl } from "@/lib/file-resource-url";
import { attachSessionImage, type SessionImageResource } from "@/lib/session-image-loader";
import { useI18n } from "@/hooks/useI18n";
import { imageSource, resultImageFileName } from "@/lib/result-image";
import type { ImageContent } from "@/lib/types";
import { ImagePreview } from "./ImagePreview";

function imageMediaType(image: ImageContent): string | undefined {
  return image.source?.media_type ?? (image as unknown as { mimeType?: string }).mimeType;
}

export function ResultImage({ image, index, sessionId: ownerSessionId }: { image: ImageContent; index: number; sessionId?: string }) {
  const { t } = useI18n();
  const source = image.source?.type === "session" && image.source.sessionId === ownerSessionId ? image.source : null;
  const sessionId = source?.sessionId;
  const entryId = source?.entryId;
  const blockIndex = source?.blockIndex;
  const key = source ? JSON.stringify([sessionId, entryId, blockIndex]) : null;
  const [resolved, setResolved] = useState<{ key: string; resource: SessionImageResource } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key || sessionId === undefined || entryId === undefined || blockIndex === undefined) return;
    setLoadFailed(false);
    setResolved(null);
    return attachSessionImage({ type: "session", sessionId, entryId, blockIndex }, openSessionImageResourceUrl, (resource) => setResolved({ key, resource }), () => setLoadFailed(true));
  }, [key, attempt, sessionId, entryId, blockIndex]);
  const resource = key && resolved?.key === key ? resolved.resource : null;
  const src = key ? resource?.url ?? "" : imageSource(image);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const loading = key !== null && !src && !loadFailed;
  const failed = !loading && (!src || failedSource === src);
  const alt = t("chat.resultImageLabel", { number: index + 1 });

  return (
    <div className="result-image">
      {loading ? <div role="status">{t("chat.imageLoading")}</div> : failed ? (
        <div className="result-image-failure" role="status">
          {t("chat.imageLoadFailed")}
          {(src || key) && <button type="button" onClick={() => { setFailedSource(null); setAttempt((value) => value + 1); }}>{t("common.retry")}</button>}
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
            const name = resultImageFileName(imageMediaType(image), index);
            if (resource?.save) await resource.save(name);
            else {
              const { downloadUrlAsFile } = await import("@/lib/desktop-native");
              await downloadUrlAsFile(src, name);
            }
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
export function ToolResultImages({ images, isError, sessionId }: { images: ImageContent[]; isError: boolean; sessionId?: string }) {
  return (
    <div className="tool-result-images" data-error={isError || undefined}>
      {images.map((image, index) => <ResultImage key={index} image={image} index={index} sessionId={sessionId} />)}
    </div>
  );
}
