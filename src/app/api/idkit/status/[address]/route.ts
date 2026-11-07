import { NextRequest } from "next/server";
import { isAddress } from "viem";
import { signalFor, humanStatus } from "@/lib/idkit/proof-of-human";

/** Port of the protocol's /api/idkit/status/:address — DB read instead of a contract read. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  if (!isAddress(address, { strict: false })) {
    return Response.json({ error: "bad address" }, { status: 400 });
  }
  return Response.json({
    address,
    signal: signalFor(address),
    ...(await humanStatus(address)),
  });
}
