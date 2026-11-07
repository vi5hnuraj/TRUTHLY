export function idkitWalletBindingMessage(input: {
  address: string;
  nonce: string;
  action: string;
}): string {
  return [
    "TRUTHLY human principal",
    "",
    "I control the owner wallet that this one-time IDKit proof will bind.",
    `Wallet: ${input.address.toLowerCase()}`,
    `Action: ${input.action}`,
    `Request nonce: ${input.nonce}`,
    "",
    "This signature does not authorize a payment or transaction.",
  ].join("\n");
}
