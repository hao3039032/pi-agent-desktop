import fs from "fs";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { textPreviewChunk } from "./text-preview-bytes";

export interface TextPreviewChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
}

export function readTextPreviewChunk(
  filePath: string,
  fileSize: number,
  offset: number,
): TextPreviewChunk {
  const length = Math.min(TEXT_PREVIEW_MAX_BYTES + 1, fileSize - offset);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
  } finally {
    fs.closeSync(descriptor);
  }

  return textPreviewChunk(buffer.subarray(0, bytesRead), fileSize, offset);
}
