import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";

/**
 * ENSv2 resolution layer — the byline verification spine.
 *
 * Scope note (Oct 2026): ENSv2 adds the hierarchical registry, Permissioned
 * Registries/Resolvers, Enhanced Access Control and wildcard resolution.
 * Universal resolution actions (getEnsAddress / getEnsText) walk the name's
 * resolver, so wildcard-resolved subnames off a parent resolver resolve
 * through the same actions. Chain selection is explicit: mainnet for the
 * continuity-lane integration, Sepolia for testnet rehearsal.
 *
 * NO MOCKS in production paths: `verifyBylineOwnership` talks to a real chain
 * RPC. Tests inject a client via the `client` parameter (documented test hook,
 * same pattern as the protocol's setSignerForTests) — production calls don't.
 */

// Simple in-process memo: name → resolved address verdict (5 min).
const cache = new Map<string, { address: string | null; expires: number }>();
const CACHE_TTL = 5 * 60;

export function publicEnsClient(chain: "mainnet" | "sepolia" = "mainnet"): PublicClient {
  return createPublicClient({
    chain: chain === "mainnet" ? mainnet : sepolia,
    transport: http(
      chain === "mainnet"
        ? process.env.OPENCHAIN_MAINNET_RPC || "https://eth.llamarpc.com"
        : process.env.OPENCHAIN_SEPOLIA_RPC || "https://rpc.sepolia.org",
    ),
  }) as PublicClient;
}

export type BylineVerification = {
  name: string;
  wallet: string;
  resolvedAddress: string | null;
  verified: boolean;
  reason: "match" | "unregistered" | "mismatch";
};

/**
 * ENSIP-25 style check: does `name` resolve on-chain to exactly `wallet`?
 * Prices one RPC roundtrip, memoized 5 minutes.
 */
export async function verifyBylineOwnership(
  name: string,
  wallet: string,
  client: PublicClient = publicEnsClient("mainnet"),
): Promise<BylineVerification> {
  // Normalize: names are case-insensitive; wallets compare case-insensitively.
  const normalizedName = name.trim().toLowerCase();
  const normalizedWallet = wallet.trim().toLowerCase();
  const cacheKey = `${normalizedName}:${normalizedWallet}`;

  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return verdict(normalizedName, normalizedWallet, hit.address);
  }

  let resolved: string | null = null;
  try {
    resolved = (await client.getEnsAddress({ name: normalizedName })) ?? null;
  } catch {
    // RPC hiccup → treat as unverified this pass (never fail a reporter's claim on infra).
    return verdict(normalizedName, normalizedWallet, null, "unregistered");
  }
  cache.set(cacheKey, { address: resolved, expires: Date.now() + CACHE_TTL * 1000 });
  return verdict(normalizedName, normalizedWallet, resolved);

  function verdict(name2: string, wallet2: string, addr: string | null, force?: "unregistered"): BylineVerification {
    if (force) return { name: name2, wallet: wallet2, resolvedAddress: null, verified: false, reason: force };
    if (!addr) return { name: name2, wallet: wallet2, resolvedAddress: null, verified: false, reason: "unregistered" };
    return {
      name: name2,
      wallet: wallet2,
      resolvedAddress: addr,
      verified: addr.toLowerCase() === wallet2,
      reason: addr.toLowerCase() === wallet2 ? "match" : "mismatch",
    };
  }
}

/** Read any text record (ENSIP-26 agent keys land here too). */
export async function bylineText(
  name: string,
  key: string,
  client: PublicClient = publicEnsClient("mainnet"),
): Promise<string | null> {
  try {
    return (await client.getEnsText({ name, key })) ?? null;
  } catch {
    return null;
  }
}

/** Sanity guard for claim endpoints: syntactically a name, not free text. */
export function isPlausibleEnsName(name: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/.test(name.trim().toLowerCase());
}
