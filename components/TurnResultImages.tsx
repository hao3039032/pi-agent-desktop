"use client";

import { createContext, memo, useContext, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TurnResultImage } from "@/lib/turn-result-images";
import { ResultImage } from "./ToolResultImages";

// Scoped only to process/stream views whose generated images have an external owner.
// Context updates also reach memoized MessageViews without prop-drilling through every block.
export const TurnImageTargetContext = createContext<string | null>(null);

export function TurnImageReference() {
  const target = useContext(TurnImageTargetContext);
  const { t } = useI18n();
  if (!target) return null;
  return <button className="turn-image-reference" type="button" onClick={() => {
    const element = document.getElementById(target);
    element?.scrollIntoView({ block: "nearest" });
    element?.focus({ preventScroll: true });
  }}>{t("chat.viewResultImages")}</button>;
}

export function TurnImageOwner({ id, images, children }: { id: string; images: readonly TurnResultImage[]; children: React.ReactNode }) {
  return (
    <>
      <TurnImageTargetContext.Provider value={images.length ? id : null}>{children}</TurnImageTargetContext.Provider>
      <TurnResultImages id={id} images={images} />
    </>
  );
}

export const TurnResultImages = memo(function TurnResultImages({ id, images }: { id: string; images: readonly TurnResultImage[] }) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  if (!images.length) return null;
  const shown = showAll ? images : images.slice(0, 4);
  return (
    <section id={id} className="turn-result-images" tabIndex={-1} aria-label={t("chat.resultImages")}>
      <div className="turn-result-images-grid" data-multiple={images.length > 1 || undefined}>
        {shown.map((item, index) => (
          <div key={item.key} className="turn-result-image" data-image-key={item.key}>
            <ResultImage image={item.image} index={index} />
            {item.isError && <div className="result-image-failure" role="status">{t("chat.imageSourceError")}</div>}
          </div>
        ))}
      </div>
      {images.length > 4 && <button className="turn-image-reference" type="button" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
        {showAll ? t("i18n.collapse") : t("chat.showAllResultImages", { count: images.length })}
      </button>}
    </section>
  );
}, (previous, next) => previous.id === next.id && previous.images.length === next.images.length
  && previous.images.every((item, index) => item.key === next.images[index].key
    && item.image === next.images[index].image && item.isError === next.images[index].isError));
