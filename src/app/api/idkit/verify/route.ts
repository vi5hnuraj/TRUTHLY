import { NextRequest } from "next/server";
import { getAddress, isAddress, recoverMessageAddress } from "viem";
import type { IDKitResult } from "@worldcoin/idkit-core";
import {
  ProofRejected,
  checkResult,
  consumeNonce,
  idkitEnabled,
  registerHuman,
  verifyWithPortal,
} from "@/lib/idkit/proof-of-human";
import { idkitConfig } from "@/lib/idkit/config";
import { idkitWalletBindingMessage } from "@/lib/idkit/wallet-binding";

/**
 * handleVerify — port of the protocol's /api/idkit/verify. The order is the protocol's:
 * local checks → Portal verification → nonce consumption → uniqueness binding.
 */
export async function POST(req: NextRequest) {
  if (!idkitEnabled()) {
    return Response.json({ error: "IDKit is not configured on this backend" }, { status: 501 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    address?: string;
    idkitResponse?: IDKitResult;
    walletSignature?: `0x${string}`;
  };
  if (!body.address || !isAddress(body.address, { strict: false })) {
    return Response.json({ error: "address required" }, { status: 400 });
  }
  if (!body.idkitResponse) {
    return Response.json({ error: "idkitResponse required" }, { status: 400 });
  }
  if (!body.walletSignature || !/^0x[0-9a-fA-F]+$/.test(body.walletSignature)) {
    return Response.json({ error: "owner-wallet signature required" }, { status: 400 });
  }

  try {
    await checkResult(body.idkitResponse, body.address);
    const recovered = await recoverMessageAddress({
      message: idkitWalletBindingMessage({
        address: body.address,
        nonce: body.idkitResponse.nonce,
        action: idkitConfig.action,
      }),
      signature: body.walletSignature,
    });
    if (recovered.toLowerCase() !== getAddress(body.address).toLowerCase()) {
      throw new ProofRejected("wallet signature does not match the principal owner wallet");
    }
    const nullifier = await verifyWithPortal(body.idkitResponse);
    await consumeNonce(body.idkitResponse.nonce);
    const { already, principalId } = await registerHuman(body.address, nullifier);
    return Response.json({ verified: true, already, principal_id: principalId });
  } catch (err) {
    if (err instanceof ProofRejected) {
      return Response.json({ verified: false, error: err.message }, { status: err.status });
    }
    return Response.json({ verified: false, error: String((err as Error).message) }, { status: 500 });
  }
}
