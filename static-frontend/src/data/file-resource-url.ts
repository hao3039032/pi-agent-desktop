import { grantFileResource, revokeFileResource } from "./file-service";

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
