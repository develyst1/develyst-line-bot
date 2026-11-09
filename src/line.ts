import { createHmac, timingSafeEqual } from "node:crypto";

/** LINE webhook signature: base64(HMAC-SHA256(channelSecret, raw body)), compared in constant time. An empty secret never verifies. */
export function verifySignature(secret: string, rawBody: Uint8Array, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const want = createHmac("sha256", secret).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface PushMessageText {
  type: "text";
  text: string;
}
export interface PushMessageImage {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
}
export interface PushBody {
  to: string | null;
  messages: (PushMessageText | PushMessageImage)[];
}

/** The text first, then one image message per URL (the same URL for the original and the preview). */
export function buildPushBody(to: string | null, text: string, imageUrls: string[]): PushBody {
  return {
    to,
    messages: [{ type: "text", text }, ...imageUrls.map((u): PushMessageImage => ({ type: "image", originalContentUrl: u, previewImageUrl: u }))],
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * POST {apiBase}/v2/bot/message/push. `retryKey` (a UUID) makes a retry of the SAME send a no-op on LINE's side.
 * Returns LINE's status only: the token is never returned or logged, and neither is LINE's body.
 */
export async function pushToLine(
  cfg: { apiBase: string; accessToken: string },
  body: PushBody,
  retryKey: string,
  fetchImpl: FetchLike,
): Promise<{ ok: boolean; status: number | null }> {
  try {
    const res = await fetchImpl(`${cfg.apiBase}/v2/bot/message/push`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.accessToken}`,
        "x-line-retry-key": retryKey,
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}
