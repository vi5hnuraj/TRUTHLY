export function worldEnrollmentMessage(input: {
  address: string;
  issuedAt: string;
  nonce: string;
}): string {
  return [
    "TRUTHLY World Agent Pass enrollment",
    "",
    "Start a fresh World authentication ceremony for this owner wallet.",
    `Owner wallet: ${input.address.toLowerCase()}`,
    `Issued at: ${input.issuedAt}`,
    `Nonce: ${input.nonce}`,
    "",
    "This signature does not move funds, approve a trade, or complete enrollment by itself.",
  ].join("\n");
}
