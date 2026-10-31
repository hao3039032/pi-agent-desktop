export interface DistroServiceStatus {
  providerId: string;
  providerName: string;
  configured: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  npmMirror: boolean;
}

export interface DistroServiceConfig {
  baseUrl: string;
  apiKey: string;
  useNpmMirror: boolean;
}

function validateStatus(data: Partial<DistroServiceStatus>): DistroServiceStatus {
  if (typeof data?.baseUrl !== "string" || typeof data?.providerId !== "string") {
    throw new Error("Invalid distro status");
  }
  return data as DistroServiceStatus;
}

export async function fetchDistroStatus(): Promise<DistroServiceStatus> {
  const response = await fetch("/api/distro", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return validateStatus(await response.json());
}

export async function configureDistroService(config: DistroServiceConfig): Promise<DistroServiceStatus> {
  const response = await fetch("/api/distro", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await response.json() as DistroServiceStatus & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return validateStatus(data);
}
