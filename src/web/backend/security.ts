import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const TOKEN_HEADER = "x-local-token";

export function createLocalToken(): string {
  return randomBytes(24).toString("hex");
}

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Host header values this server answers to (DNS-rebinding protection). */
export function allowedHosts(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

export function allowedOrigins(port: number): Set<string> {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
}

export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
}

export interface GuardFailure {
  status: number;
  code: string;
  message: string;
}

/** Host + Origin checks shared by every request. Returns a failure or undefined. */
export function checkRequestOrigin(req: IncomingMessage, port: number): GuardFailure | undefined {
  const host = req.headers.host;
  if (!host || !allowedHosts(port).has(host.toLowerCase())) {
    return { status: 403, code: "BAD_HOST", message: "Unexpected Host header. This service only answers on localhost." };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins(port).has(origin.toLowerCase())) {
    return { status: 403, code: "BAD_ORIGIN", message: "Cross-origin requests are not allowed." };
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return { status: 403, code: "BAD_ORIGIN", message: "Cross-site requests are not allowed." };
  }
  return undefined;
}
