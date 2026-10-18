import type { AgentMessage, CustomMessage, ImageContent, ToolResultMessage } from "./types";

export interface GeneratedImageOutput {
  blockIndex: number;
  kind: "generated-image";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the versioned producer contract is authoritative; never guess from tool names or logs. */
export function projectModelImages(value: unknown): { version: 1; outputs: GeneratedImageOutput[] } | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.outputs)) return undefined;
  const seen = new Set<number>();
  const outputs: GeneratedImageOutput[] = [];
  for (const item of value.outputs.slice(0, 100)) {
    if (!isRecord(item) || item.kind !== "generated-image" || !Number.isSafeInteger(item.blockIndex)
      || (item.blockIndex as number) < 0 || seen.has(item.blockIndex as number)) continue;
    const blockIndex = item.blockIndex as number;
    seen.add(blockIndex);
    outputs.push({ blockIndex, kind: "generated-image" });
  }
  return outputs.length ? { version: 1, outputs } : undefined;
}

export function generatedImageIndices(result: ToolResultMessage): Set<number> {
  const metadata = isRecord(result.details) ? projectModelImages(result.details.modelImages) : undefined;
  const outputs = metadata?.outputs;
  if (!outputs?.length) return new Set();
  const imageIndices: number[] = [];
  result.content.forEach((block, index) => {
    if (block.type === "image") imageIndices.push(index);
  });
  // The producer appends tagged images contiguously at the tail of the content, but the
  // SDK runs normalizeToolResultImages only after the tool_result hook and inserts a text
  // hint block after every resized/transcoded image, so the raw blockIndex values drift
  // while image-block ordinals stay stable (text blocks are never added or dropped as
  // images). Align the tagged outputs with the trailing image blocks instead of trusting
  // raw indices; when the result no longer has enough image blocks (e.g. deferred history
  // dropped some), fall back to the strict index check.
  if (outputs.length <= imageIndices.length) return new Set(imageIndices.slice(-outputs.length));
  return new Set(outputs
    .filter(({ blockIndex }) => result.content[blockIndex]?.type === "image")
    .map(({ blockIndex }) => blockIndex));
}

const customImageCache = new WeakMap<CustomMessage, ImageContent>();

/** pi-model-images uses this explicit custom message for nested CLI calls. */
export function customGeneratedImage(message: AgentMessage): ImageContent | null {
  if (message.role !== "custom" || message.customType !== "model-image" || message.display === false) return null;
  const details = message.details;
  if (!isRecord(details) || typeof details.data !== "string" || !details.data
    || typeof details.mimeType !== "string" || !/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(details.mimeType)) return null;
  const cached = customImageCache.get(message);
  if (cached?.source.data === details.data && cached.source.media_type === details.mimeType) return cached;
  const image: ImageContent = { type: "image", source: { type: "base64", data: details.data, media_type: details.mimeType } };
  customImageCache.set(message, image);
  return image;
}

export interface TurnResultImage {
  key: string;
  image: ImageContent;
  isError: boolean;
  toolName?: string;
}

/** The caller supplies only the active branch's current turn, including a live assistant if any. */
export function collectTurnResultImages(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  messageKeys: readonly (string | number)[] = [],
): TurnResultImage[] {
  const images: TurnResultImage[] = [];
  const seenCalls = new Set<string>();
  // Stream-capture paths write the image into the assistant text as `![image](file://…)`
  // markdown and also emit a model-image custom message for the TUI. The web UI renders
  // the file:// markdown inline, so a custom image whose path that same turn already
  // references would show the same pixels twice — skip it. Computed lazily; most turns
  // have no custom image at all.
  let inlineMarkdownText: string | undefined;
  const inlineMarkdown = () => {
    if (inlineMarkdownText === undefined) {
      inlineMarkdownText = "";
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
          if (block.type === "text") inlineMarkdownText += `${block.text}\n`;
        }
      }
    }
    return inlineMarkdownText;
  };
  // Markdown image/link target forms only. The extension's own `saved.markdown` is
  // `![image](file://<path>)`; the data-URI catcher writes bare Windows drive paths as
  // `![alt](C:\...)` and the web UI still resolves drive-letter hrefs (resolveLocalFileHref).
  // Matching the `](...)` target form keeps a prose mention of the path — even a bare
  // file:// autolink, which renders as a link rather than inline pixels — from suppressing
  // the gallery copy.
  const isInlineMarkdownImage = (text: string, filePath: string) =>
    text.includes(`](file://${filePath})`) || text.includes(`](${filePath})`);
  const appendResult = (result: ToolResultMessage | undefined) => {
    if (!result || seenCalls.has(result.toolCallId)) return;
    seenCalls.add(result.toolCallId);
    const indices = generatedImageIndices(result);
    result.content.forEach((block, blockIndex) => {
      if (block.type === "image" && indices.has(blockIndex)) {
        images.push({ key: `tool:${result.toolCallId}:${blockIndex}`, image: block, isError: !!result.isError, toolName: result.toolName });
      }
    });
  };
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") appendResult(toolResults.get(block.toolCallId));
      }
    } else if (message.role === "toolResult") {
      // Also handles a history page whose paired assistant call is not loaded yet.
      appendResult(message);
    } else {
      const image = customGeneratedImage(message);
      if (!image) return;
      const details = message.role === "custom" ? message.details : undefined;
      const filePath = isRecord(details) && typeof details.filePath === "string"
        ? details.filePath
        : "";
      if (filePath && isInlineMarkdownImage(inlineMarkdown(), filePath)) return; // already rendered from the answer text
      images.push({ key: `custom:${messageKeys[index] ?? index}`, image, isError: false });
    }
  });
  return images;
}
