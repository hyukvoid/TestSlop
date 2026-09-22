import { createHmac, timingSafeEqual } from "node:crypto";
import { SignatureMismatch } from "./errors.ts";

export interface SignedPayload {
  timestamp: number;
  signature: string;
}

const SCHEME = "v1";

export function signPayload(body: string, secret: string, timestamp: number): SignedPayload {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.${body}`);
  return { timestamp, signature: `${SCHEME}=${mac.digest("hex")}` };
}

export function serialiseHeader(signed: SignedPayload): string {
  return `t=${signed.timestamp},${signed.signature}`;
}

export function parseHeader(header: string): SignedPayload | undefined {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t" && value) timestamp = Number(value);
    if (key === SCHEME && value) signature = `${SCHEME}=${value}`;
  }
  if (timestamp === undefined || Number.isNaN(timestamp) || !signature) return undefined;
  return { timestamp, signature };
}

export const TOLERANCE_SECONDS = 300;

export function verifyPayload(
  body: string,
  header: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): true {
  const parsed = parseHeader(header);
  if (!parsed) throw new SignatureMismatch();

  if (Math.abs(now - parsed.timestamp) > TOLERANCE_SECONDS) {
    throw new SignatureMismatch();
  }

  const expected = signPayload(body, secret, parsed.timestamp).signature;
  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SignatureMismatch();
  }
  return true;
}
