/**
 * The exact text a human signs for the emergency switch and for resuming.
 *
 * Kept in a shared module so the API and any client build the same bytes. The
 * timestamp is inside the signed message, so a captured signature cannot be
 * replayed after the nonce table is pruned.
 */

const body = (input: {
  verb: string;
  address: string;
  reason: string;
  issuedAt: string;
  nonce: string;
}) =>
  [
    `TRUTHLY ${input.verb}`,
    "",
    `Principal: ${input.address.toLowerCase()}`,
    `Reason: ${input.reason}`,
    `Issued At: ${input.issuedAt}`,
    `Nonce: ${input.nonce}`,
    "",
    "This signature changes TRUTHLY authority only. It does not move funds, sign a trade, or approve an order.",
  ].join("\n");

export const pauseMessage = (input: {
  address: string;
  reason: string;
  issuedAt: string;
  nonce: string;
}) => body({ ...input, verb: "emergency pause" });

/** A signature minted for the switch is only useful for this window. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
