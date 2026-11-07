import { lookup } from "node:dns/promises";

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPrivateV6(address: string): boolean {
  const a = address.toLowerCase();
  if (a === "::" || a === "::1") return true;
  if (a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80")) return true;
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? PRIVATE_V4.test(mapped[1]) : false;
}

/**
 * Resolves a hostname and accepts it only if every address is public, which blocks
 * names like 127.0.0.1.nip.io that pass a hostname-only check.
 */
export async function resolvesToPublic(hostname: string): Promise<boolean> {
  try {
    const addresses = await lookup(hostname, { all: true });
    return (
      addresses.length > 0 &&
      addresses.every((a) => (a.family === 6 ? !isPrivateV6(a.address) : !PRIVATE_V4.test(a.address)))
    );
  } catch {
    return false;
  }
}
