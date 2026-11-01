import { grantFilePreview, grantFileResource, grantSessionToolResultImage, revokeFileResource } from "./file-service";

export function initialFileResourceUrl(_path: string, _sessionId?: string | null, _revision?: number, _preview = false): undefined { return undefined; }

/** The handle names one host-authorized file, not an arbitrary filesystem path. */
export async function openFileResourceUrl(path: string, sessionId?: string | null, _revision?: number): Promise<{ url: string; release: () => void }> {
  const handle = await grantFileResource(path, sessionId);
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = convertFileSrc(handle, "pi-resource");
    return { url, release: () => { void revokeFileResource(handle).catch(() => {}); } };
  } catch (error) {
    await revokeFileResource(handle).catch(() => {});
    throw error;
  }
}

export async function openSessionImageResourceUrl(sessionId: string, entryId: string, blockIndex: number): Promise<{ url: string; release: () => void; save: (name: string) => Promise<boolean> }> {
  const handle = await grantSessionToolResultImage(sessionId, entryId, blockIndex);
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return {
      url: convertFileSrc(handle, "pi-resource"),
      release: () => { void revokeFileResource(handle).catch(() => {}); },
      save: async (name) => (await import("../../../lib/desktop-native")).saveResourceAsNative(handle, name),
    };
  } catch (error) {
    await revokeFileResource(handle).catch(() => {});
    throw error;
  }
}

export async function openFilePreviewUrl(path: string, _sessionId?: string | null, _revision?: number): Promise<{ url: string; release: () => void }> {
  const { handle, name } = await grantFilePreview(path);
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const url = `${convertFileSrc(handle, "pi-resource")}/${encodeURIComponent(name)}`;
    return { url, release: () => { void revokeFileResource(handle).catch(() => {}); } };
  } catch (error) {
    await revokeFileResource(handle).catch(() => {});
    throw error;
  }
}
