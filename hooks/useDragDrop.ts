"use client";

import { useState, useCallback, useRef } from "react";
import type { DroppedItem } from "@/lib/file-upload-client";

function hasDraggedFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** A drop's files, with dropped folders named instead (they cannot be read as one file). */
export function droppedItems(dataTransfer: DataTransfer): DroppedItem[] {
  const items: DroppedItem[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      items.push({ kind: "folder", name: entry.name });
      continue;
    }
    const file = item.getAsFile();
    if (file) items.push({ kind: "file", file });
  }
  if (items.length > 0) return items;
  return Array.from(dataTransfer.files).map((file) => ({ kind: "file", file }));
}

/**
 * The hook reports plain files plus the names of dropped folders: a browser
 * cannot read a folder's contents, so callers either refuse them (the chat's
 * "not supported in the browser" notice) or handle them another way. The
 * desktop shell never drops through this hook (its native drag/drop owns it).
 */
export function useDragDrop(onDrop: (files: File[], folders: string[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    const items = droppedItems(e.dataTransfer);
    const files = items.flatMap((item) => (item.kind === "file" ? [item.file] : []));
    const folders = items.flatMap((item) => (item.kind === "folder" ? [item.name] : []));
    if (files.length > 0 || folders.length > 0) onDrop(files, folders);
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}
