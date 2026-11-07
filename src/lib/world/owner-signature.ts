import { verifyMessage } from "viem";
import { getDb, schema } from "@/lib/db";
import { normalizeWallet } from "./principals";
import { SIGNATURE_WINDOW_MS } from "./pause-message";

export class OwnerSignatureRejected extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409 = 401,
  ) {
    super(message);
  }
}

/**
 * One-use, time-bound signature from the principal's owner wallet.
 *
 * Used only for the emergency switch, which must work without World. Resume is
 * deliberately not symmetric: it always requires fresh Agent Pass. The nonce
 * is namespaced so it cannot collide with a legacy request nonce.
 */
export async function consumeOwnerSignature(input: {
  address: string;
  message: string;
  signature: string;
  issuedAt: string;
  nonce: string;
  namespace?: string;
}): Promise<void> {
  const issued = Date.parse(input.issuedAt);
  const now = Date.now();
  if (
    !Number.isFinite(issued) ||
    issued > now + 60_000 ||
    now - issued > SIGNATURE_WINDOW_MS
  ) {
    throw new OwnerSignatureRejected("This signature has expired. Sign a new request.", 401);
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: normalizeWallet(input.address) as `0x${string}`,
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) throw new OwnerSignatureRejected("Signature does not match the owner wallet.", 401);

  const db = await getDb();
  const inserted = await db
    .insert(schema.nonces)
    .values({ nonce: `${input.namespace ?? "principal"}:${input.nonce}`, usedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ nonce: schema.nonces.nonce })
    .all();
  if (inserted.length !== 1) {
    throw new OwnerSignatureRejected("This signature was already used.", 409);
  }
}
