import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";

/** The extra lookahead byte keeps a UTF-8 sequence together across pages. */
export function textPreviewChunk(bytes: Uint8Array, fileSize: number, offset: number) {
  let end = Math.min(bytes.length, TEXT_PREVIEW_MAX_BYTES);
  if (offset + end < fileSize) {
    let start = end;
    while (start > end - 3 && (bytes[start] & 0xc0) === 0x80) start--;
    const byte = bytes[start];
    const length = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
    if (length > end - start) end = start;
  }
  const nextOffset = offset + end;
  return { content: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, end)), nextOffset, truncated: nextOffset < fileSize };
}
