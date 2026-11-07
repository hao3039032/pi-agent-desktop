import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isListeningBeyondLoopback } from "./request-security.ts";

/** One address of this computer another device could try to reach. */
export interface LanAddress {
  /** An IPv4 address, e.g. `192.168.1.20`. */
  address: string;
  /** The adapter that holds the address, e.g. `en0`, `vEthernet (Hyper-V)`. */
  interface: string;
}

/**
 * What a local caller may learn about the running server's network exposure.
 * Only ever served to the desktop window (loopback + per-process token).
 */
export interface LanAddressStatus {
  /** The port this server is bound to; null when neither env nor request says. */
  port: number | null;
  /** Whether the running server accepts connections from beyond loopback. */
  lanListening: boolean;
  /** This machine's non-internal IPv4 addresses, one entry per adapter address. */
  addresses: LanAddress[];
}

function asPort(value: number): number | null {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

/**
 * This machine's non-internal IPv4 addresses. Every adapter is included —
 * virtual ones (Hyper-V, VMware, docker) name themselves, which is what tells
 * the user an address may not actually reach this computer.
 */
export function collectLanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): LanAddress[] {
  const addresses: LanAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      // Node < 18.18 reports the family as the number 4.
      const family = String(entry.family);
      if (entry.internal || (family !== "IPv4" && family !== "4")) continue;
      addresses.push({ address: entry.address, interface: name });
    }
  }
  // Stable order so the list does not jump between reads. Codepoint order,
  // not locale collation: adapter names mix case and punctuation ("en0",
  // "vEthernet (Hyper-V)") and ICU collation varies by host.
  addresses.sort((a, b) => (a.interface < b.interface ? -1 : a.interface > b.interface ? 1
    : a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return addresses;
}

/** The port this server listens on: the launcher's `PORT`, else the request's own host. */
function listeningPort(env: NodeJS.ProcessEnv, hostHeader: string | null): number | null {
  const fromEnv = asPort(Number.parseInt(env.PORT ?? "", 10));
  if (fromEnv !== null) return fromEnv;
  if (!hostHeader) return null;
  // `127.0.0.1:30141` and `[::1]:30141` both end after the last colon; a host
  // without one carries no port.
  const colon = hostHeader.lastIndexOf(":");
  if (colon === -1) return null;
  return asPort(Number.parseInt(hostHeader.slice(colon + 1), 10));
}

/**
 * The network state behind the "Allow network access" switch: what the running
 * server actually does (`lanListening` reads the bind the launcher passed via
 * `PI_WEB_HOSTNAME`), not the stored preference — that takes a restart, and the
 * UI must show the difference instead of promising the switch works instantly.
 */
export function desktopLanAddressStatus(
  hostHeader: string | null,
  env: NodeJS.ProcessEnv = process.env,
): LanAddressStatus {
  return {
    port: listeningPort(env, hostHeader),
    lanListening: isListeningBeyondLoopback(),
    addresses: collectLanAddresses(),
  };
}
