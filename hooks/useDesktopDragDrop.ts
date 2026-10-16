"use client";

import { useEffect, useRef, useState } from "react";
import { isTauriDesktop } from "@/lib/desktop-updater";

// Guard so a listener failure is reported once per page, not once per
// remount — the native handler stays enabled either way, so OS file drops
// never reach the HTML5 handlers as a fallback.
let dragDropListenerWarned = false;

/**
 * Desktop-shell drag/drop. Tauri's native drag/drop handler is enabled in the
 * packaged shell — it is the only way to learn the absolute paths of dragged
 * items — so OS file drags arrive as webview events (`tauri://drag-*`) instead
 * of HTML5 drop events. Browser builds keep using `useDragDrop` (HTML5).
 *
 * Drag positions are physical pixels relative to the webview's top-left
 * corner on Windows, but logical points on macOS and Linux, so
 * `devicePixelRatio` is only applied on Windows before hit-testing the drop
 * zone. The drop is only accepted while the cursor is over `dropZoneRef`,
 * matching what the HTML5 handlers accept in the browser.
 */
export function useDesktopDragDrop(options: {
  dropZoneRef: React.RefObject<HTMLElement | null>;
  onDropPaths: (paths: string[]) => void;
}): { isDragOver: boolean } {
  const [isDragOver, setIsDragOver] = useState(false);
  const { dropZoneRef } = options;
  const onDropPathsRef = useRef(options.onDropPaths);
  onDropPathsRef.current = options.onDropPaths;

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    // wry reports drag positions in physical pixels on Windows, but in
    // logical points on macOS (AppKit points, wkwebview/drag_drop.rs) and
    // Linux (GTK widget coordinates, webkitgtk). Divide by devicePixelRatio
    // only where the coordinates are physical.
    const dragUsesPhysicalPixels =
      navigator.platform.includes("Win") || navigator.userAgent.includes("Windows");

    const isOverDropZone = (dragX: number, dragY: number): boolean => {
      const zone = dropZoneRef.current;
      if (!zone) return false;
      const ratio = dragUsesPhysicalPixels ? window.devicePixelRatio || 1 : 1;
      const element = document.elementFromPoint(dragX / ratio, dragY / ratio);
      return element instanceof Node && zone.contains(element);
    };

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          const inside = isOverDropZone(payload.position.x, payload.position.y);
          setIsDragOver((prev) => (prev === inside ? prev : inside));
        } else if (payload.type === "leave") {
          setIsDragOver(false);
        } else if (payload.type === "drop") {
          const inside = isOverDropZone(payload.position.x, payload.position.y);
          setIsDragOver(false);
          if (inside && payload.paths.length > 0) {
            onDropPathsRef.current(payload.paths);
          }
        }
      }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Listening failed (older shell or missing permission). The native
        // drag/drop handler stays enabled, so OS file drops cannot fall back
        // to the HTML5 handlers — they are ignored in this window.
        if (!dragDropListenerWarned) {
          dragDropListenerWarned = true;
          console.warn(
            "useDesktopDragDrop: registering the Tauri drag/drop listener failed; OS file drops will be ignored",
          );
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, [dropZoneRef]);

  return { isDragOver };
}
