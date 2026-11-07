import { ProofRejected, idkitEnabled, issueRpSignature } from "@/lib/idkit/proof-of-human";

/** Issues the RP context (signed request) for IDKitRequestWidget — port of the protocol. */
export async function POST() {
  if (!idkitEnabled()) {
    return Response.json({ error: "IDKit is not configured on this backend" }, { status: 501 });
  }
  try {
    return Response.json(await issueRpSignature());
  } catch (err) {
    return Response.json({ error: err instanceof ProofRejected ? err.message : "rp signature failed" }, { status: 500 });
  }
}
