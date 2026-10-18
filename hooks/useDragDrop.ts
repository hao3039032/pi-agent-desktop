"use client";

import { useState, useCallback, useRef } from "react";

function hasDraggedFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

interface FileSystemEntryLike {
  isDirectory?: boolean;
  name?: string;
}

/**
 * Directory names among the dragged items. `webkitGetAsEntry` is the only
 * reliable way to tell a dropped folder from a file, and it must be called
 * synchronously — the items list is invalidated once the handler yields.
 * Browsers otherwise hand folders over as unreadable size-0 File objects that
 * fail as bogus "network" upload errors.
 */
function collectDirectoryNames(event: React.DragEvent): string[] {
  const items = event.dataTransfer?.items;
  if (!items) return [];
  const names: string[] = [];
  for (const item of Array.from(items)) {
    const getEntry = (item as { webkitGetAsEntry?: () => FileSystemEntryLike | null }).webkitGetAsEntry;
    if (typeof getEntry !== "function") continue;
    const entry = getEntry.call(item);
    if (entry?.isDirectory && entry.name) names.push(entry.name);
  }
  return names;
}

export function useDragDrop(onDrop: (files: File[], directories: string[]) => void) {
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
    const directories = collectDirectoryNames(e);
    const files = Array.from(e.dataTransfer.files).filter((file) => !directories.includes(file.name));
    if (files.length > 0 || directories.length > 0) onDrop(files, directories);
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}
