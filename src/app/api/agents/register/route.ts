import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Retired. File stories with an x402 payment: POST /api/x402/signals (see /llms.txt)." },
    { status: 410 },
  );
}
