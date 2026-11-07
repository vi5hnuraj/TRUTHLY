import { NextRequest, NextResponse } from "next/server";
import * as z from "zod";
import { isAddress } from "viem";
import { classifyReporterIndependence } from "@/lib/world/independence";

const schema = z.object({
  wallets: z
    .array(z.string().refine((value) => isAddress(value, { strict: false })))
    .min(1)
    .max(50),
}).strict();

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "wallets must contain 1–50 EVM addresses" }, { status: 400 });
  }
  return NextResponse.json(await classifyReporterIndependence(parsed.data.wallets));
}
