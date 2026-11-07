import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time authentication for private editor and Council operations. */
export async function verifyEditorAuth(req: NextRequest): Promise<{
  authorized: boolean;
  method: "api-key" | null;
  error?: string;
}> {
  const apiKey = req.headers.get("x-editor-key")?.trim();
  const expected = process.env.EDITOR_API_KEY?.trim();
  if (apiKey && expected && timingSafeEqual(digest(apiKey), digest(expected))) {
    return { authorized: true, method: "api-key" };
  }
  return { authorized: false, method: null, error: "Missing or invalid x-editor-key" };
}
