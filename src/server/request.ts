import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** localhost, ::1 or a 127.x.x.x address; exact, so 127.0.0.1.example.com is not. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Compares a secret in constant time; hashing makes the lengths equal, so it doesn't reveal the length either. */
export function sameSecret(candidate: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(sha256(candidate), expectedHash);
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
