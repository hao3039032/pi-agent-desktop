import { APP_PREF_KEYS, getPrefJson } from "./app-prefs";
import { CHAT_ATTACHMENT_MAX_FILES, splitMessageForComposer } from "./chat-attachments";
import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

/** A text file attached in a chat composer (see lib/chat-attachments.ts). */
export interface ChatDraftFile {
  id: string;
  name: string;
  size: number;
  text: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  /**
   * Attached text files. Kept for the life of the page only: a file can be 256 KB, which
   * would not fit the localStorage budget the drafts share, so they never reach storage.
   */
  files?: ChatDraftFile[];
}

const drafts = new Map<string, ChatDraft>();
const MAX_PERSISTED_IMAGE_BYTES = 400_000; // approx decoded size via base64 length
const MAX_PERSISTED_DRAFTS = 40;
const PARKED_NEW_SESSION_PREFIX = "parked-new:";

/** The draft key a cwd's not-yet-sent composer is parked under when the user
 *  switches away without submitting. Shared by AppShell's rekey paths and the
 *  sidebar's parked-draft rows so the spelling can never drift. */
export function parkedNewSessionDraftKey(cwd: string): string {
  return `${PARKED_NEW_SESSION_PREFIX}${cwd}`;
}

export interface ParkedNewSessionDraft {
  cwd: string;
  draft: ChatDraft;
}

let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Keys with local changes not yet written to storage. A `storage` event
 *  (another window's write) must never overwrite or delete these: this
 *  window's user-visible state is newer than anything on disk for them. */
const dirtyKeys = new Set<string>();

/** Parse one entry of the persisted draft map. Shared by hydration and the
 *  cross-window `storage` listener so both read the exact same shape (and the
 *  same image-size cap). Returns null for malformed or empty entries. */
function readPersistedDraft(value: unknown): ChatDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as ChatDraft;
  if (typeof draft.value !== "string" || !Array.isArray(draft.images)) return null;
  if (isEmptyDraft(draft)) return null;
  return {
    value: draft.value,
    images: draft.images
      .filter((image) => image && typeof image.data === "string" && typeof image.mimeType === "string")
      .filter(imagePersistable)
      .map((image) => ({ data: image.data, mimeType: image.mimeType })),
  };
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    ...(draft.files?.length ? { files: draft.files.map((file) => ({ ...file })) } : {}),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && !draft.files?.length;
}

function imagePersistable(image: ChatDraftImage): boolean {
  // base64 length ≈ 4/3 of bytes; keep a conservative cap so localStorage stays usable.
  return image.data.length * 0.75 <= MAX_PERSISTED_IMAGE_BYTES;
}

/** True when the draft carries data storage cannot represent (attached
 *  text files live only for the page's lifetime; oversized images are
 *  filtered out on every persist). For such keys the in-memory copy is the
 *  only copy, so cross-window sync must never overwrite or delete it. */
function hasMemoryOnlyData(draft: ChatDraft): boolean {
  return Boolean(draft.files?.length) || draft.images.some((image) => !imagePersistable(image));
}

/** Compare a local draft against a remote snapshot entry using exactly what
 *  storage can represent: the projection both windows persist. Comparing the
 *  raw local images would flag every oversized image as a remote change, and
 *  comparing lengths only (the old bug) missed same-count content swaps. */
function persistedProjectionEquals(local: ChatDraft, remote: ChatDraft): boolean {
  if (local.value !== remote.value) return false;
  const persistable = local.images.filter(imagePersistable);
  if (persistable.length !== remote.images.length) return false;
  return persistable.every((image, index) =>
    image.data === remote.images[index].data && image.mimeType === remote.images[index].mimeType);
}

/** The persisted form is always a plain object map. Arrays and primitives
 *  must never parse as "an empty snapshot" — that would mirror-delete every
 *  parked key this window holds. */
function isPlainDraftMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hydrateFromStorage(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const stored = getPrefJson<unknown>(APP_PREF_KEYS.chatDrafts);
  if (!isPlainDraftMap(stored)) return;
  for (const [key, draft] of Object.entries(stored)) {
    const parsed = readPersistedDraft(draft);
    if (parsed) drafts.set(key, parsed);
  }
}

function persistNow(): void {
  if (typeof window === "undefined") return;
  const entries = [...drafts.entries()]
    .slice(-MAX_PERSISTED_DRAFTS)
    .map(([key, draft]) => [
      key,
      {
        value: draft.value,
        images: draft.images.filter(imagePersistable),
      },
    ] as const);
  let persisted = false;
  try {
    // Direct write, not setPrefJson: its swallowed quota/private-mode error
    // must not clear the dirty flags below, or another window's snapshot
    // could delete the only copy of an unsaved local edit.
    window.localStorage.setItem(APP_PREF_KEYS.chatDrafts, JSON.stringify(Object.fromEntries(entries)));
    persisted = true;
  } catch {
    persisted = false; // retried by the next scheduled persist
  }
  if (!persisted) return;
  const written = new Set(entries.map(([key]) => key));
  for (const key of [...dirtyKeys]) {
    if (written.has(key)) {
      // A key whose memory-only data (files, oversized images) never reached
      // storage stays protected until it is deleted or becomes persistable.
      const draft = drafts.get(key);
      if (draft && hasMemoryOnlyData(draft)) continue;
      dirtyKeys.delete(key);
    } else if (!drafts.has(key)) {
      // Tombstone: the deletion itself was just persisted.
      dirtyKeys.delete(key);
    }
    // else: capped out of the 40-entry window — keep local protection until
    // the key is old enough to be evicted or fits again.
  }
}

function schedulePersist(): void {
  if (typeof window === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 250);
}

/** Cancel the debounced persist and write localStorage synchronously. Used on
 *  `pagehide`, where a 250ms timer would never fire. No-op without a window. */
export function flushDrafts(): void {
  if (typeof window === "undefined") return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  hydrateFromStorage();
  persistNow();
}

type ParkedDraftsListener = () => void;
const parkedListeners = new Set<ParkedDraftsListener>();
let parkedNotifyQueued = false;

function scheduleParkedNotify(): void {
  if (parkedNotifyQueued) return;
  parkedNotifyQueued = true;
  queueMicrotask(() => {
    parkedNotifyQueued = false;
    for (const listener of [...parkedListeners]) listener();
  });
}

/** Notify parked-draft subscribers when a `parked-new:*` key appears, changes
 *  or disappears. Active `new:<id>:<cwd>` keystrokes never notify — the
 *  sidebar row for them shows parked content only. */
function notifyParkedKeyChanged(key: string): void {
  if (!key.startsWith(PARKED_NEW_SESSION_PREFIX)) return;
  if (parkedListeners.size === 0) return;
  scheduleParkedNotify();
}

let storageListenerInstalled = false;
function installParkedStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== APP_PREF_KEYS.chatDrafts) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (!event.newValue) return;
    let stored: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(event.newValue);
      if (isPlainDraftMap(parsed)) stored = parsed;
    } catch {
      return; // malformed snapshot: keep this window's state untouched
    }
    if (!stored) return; // valid JSON but not a draft map (arrays included): nothing to sync
    hydrateFromStorage();
    let changed = false;
    const remoteParked = new Set<string>();
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(PARKED_NEW_SESSION_PREFIX)) continue;
      remoteParked.add(key);
      const parsed = readPersistedDraft(value);
      if (!parsed) continue;
      const local = drafts.get(key);
      // The in-memory copy is the only copy when storage cannot represent the
      // draft (files, oversized images): never overwrite it from a snapshot.
      if (local && hasMemoryOnlyData(local)) continue;
      // Unsaved local edits always win over whatever the other window wrote.
      if (dirtyKeys.has(key)) continue;
      if (local && persistedProjectionEquals(local, parsed)) continue;
      drafts.set(key, parsed);
      changed = true;
    }
    // Remote deletions: a parked key the other window dropped disappears here
    // too, or this window's next persist would resurrect it. Keys with unsaved
    // local edits — or whose memory-only copy never reached storage — survive.
    for (const key of [...drafts.keys()]) {
      if (!key.startsWith(PARKED_NEW_SESSION_PREFIX)) continue;
      if (remoteParked.has(key)) continue;
      const local = drafts.get(key);
      if (local && hasMemoryOnlyData(local)) continue;
      if (dirtyKeys.has(key)) continue;
      if (drafts.delete(key)) changed = true;
    }
    // Only parked keys are synced; this never writes storage back, so two
    // windows cannot ping-pong.
    if (changed) scheduleParkedNotify();
  });
}

/** Subscribe to parked-draft changes (microtask-debounced). Notifications are
 *  coalesced per microtask; read the current list via
 *  listParkedNewSessionDrafts() inside the listener. Installing the first
 *  listener also watches `storage`: parked keys another window wrote, updated
 *  or deleted are mirrored here — except keys with unsaved local edits or
 *  memory-only data (files, oversized images), whose in-memory copy always
 *  wins. */
export function subscribeParkedDrafts(listener: ParkedDraftsListener): () => void {
  parkedListeners.add(listener);
  installParkedStorageListener();
  return () => {
    parkedListeners.delete(listener);
  };
}

/** All parked new-session drafts currently in memory (hydrated from storage),
 *  in map insertion order. Drafts are cloned; callers cannot mutate the store. */
export function listParkedNewSessionDrafts(): ParkedNewSessionDraft[] {
  hydrateFromStorage();
  const result: ParkedNewSessionDraft[] = [];
  for (const [key, draft] of drafts) {
    if (!key.startsWith(PARKED_NEW_SESSION_PREFIX)) continue;
    result.push({ cwd: key.slice(PARKED_NEW_SESSION_PREFIX.length), draft: cloneDraft(draft) });
  }
  return result;
}

export function getDraft(key: string): ChatDraft | null {
  hydrateFromStorage();
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  hydrateFromStorage();
  dirtyKeys.add(key);
  if (isEmptyDraft(draft)) {
    const had = drafts.delete(key);
    if (had) notifyParkedKeyChanged(key);
    schedulePersist();
    return;
  }
  // Map.set() does not refresh insertion order for an existing key. Delete it
  // first so the persistence cap below keeps the most recently edited drafts.
  drafts.delete(key);
  drafts.set(key, cloneDraft(draft));
  notifyParkedKeyChanged(key);
  schedulePersist();
}

export function clearDraft(key: string): void {
  hydrateFromStorage();
  dirtyKeys.add(key);
  const had = drafts.delete(key);
  if (had) notifyParkedKeyChanged(key);
  schedulePersist();
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
  submittedFiles: ChatDraftFile[] | undefined = undefined,
  currentFiles: ChatDraftFile[] | undefined = undefined,
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));
  const files = [...(submittedFiles ?? []), ...(currentFiles ?? [])]
    .filter((file, index, all) => all.findIndex((other) => other.id === file.id) === index)
    .slice(0, CHAT_ATTACHMENT_MAX_FILES)
    .map((file) => ({ ...file }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
    ...(files.length ? { files } : {}),
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
  files?: ChatDraftFile[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  // A submission that carried attached files comes back as attachments, not as markup.
  const split = splitMessageForComposer(text);
  const restored = mergeRestoredSubmissionDraft(
    split.text,
    images,
    current.value,
    current.images,
    [...(files ?? []), ...split.files],
    current.files,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images, next.files, previous.files)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
