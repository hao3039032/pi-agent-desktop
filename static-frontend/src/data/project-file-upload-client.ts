import { checkProjectUploadTargets, uploadProjectFile } from "./file-service";
import type { ProjectUploadConflictStrategy, ProjectUploadResponse } from "../../../lib/project-file-upload-client";
export type { ProjectUploadConflictStrategy, ProjectUploadResponse } from "../../../lib/project-file-upload-client";

export const PROJECT_UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const PROJECT_UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export async function checkProjectUpload(targetDirectory: string, fileNames: string[]): Promise<ProjectUploadResponse> {
  return checkProjectUploadTargets(targetDirectory, fileNames);
}

export async function uploadProjectFiles(
  targetDirectory: string,
  files: File[],
  strategy: ProjectUploadConflictStrategy,
  onProgress?: (progress: number) => void,
): Promise<{ status: number; data: ProjectUploadResponse }> {
  if (!files.length || files.length > 100) return { status: 400, data: { error: "Invalid file selection" } };
  if (files.some((file) => file.size > PROJECT_UPLOAD_MAX_FILE_BYTES) || files.reduce((total, file) => total + file.size, 0) > PROJECT_UPLOAD_MAX_TOTAL_BYTES) {
    return { status: 413, data: { error: "Upload size limit exceeded" } };
  }
  const inspection = await checkProjectUpload(targetDirectory, files.map((file) => file.name));
  if ((strategy === "error" && inspection.conflicts?.length) || (strategy === "overwrite" && inspection.nonReplaceable?.length)) {
    return { status: 409, data: inspection };
  }
  const uploaded: string[] = [], skipped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  let completed = 0;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const result = await uploadProjectFile(targetDirectory, file.name, btoa(binary), strategy);
      if (result.outcome === "uploaded") uploaded.push(file.name);
      else if (result.outcome === "skipped") skipped.push(file.name);
      else if (!uploaded.length && !skipped.length && !errors.length) return { status: 409, data: { conflicts: [file.name], nonReplaceable: [] } };
      else errors.push({ name: file.name, error: "A conflicting file appeared during upload" });
    } catch (error) { errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) }); }
    completed += file.size;
    if (onProgress) onProgress(total ? Math.round(completed * 100 / total) : 100);
  }
  return { status: errors.length ? 207 : 200, data: { uploaded, skipped, errors } };
}
