/** Stable, machine-readable error codes shared by the MCP server, the web API and the AI orchestrator. */
export type ErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_ARGUMENTS"
  | "QUERY_REJECTED"
  | "CONFIG_MISSING"
  | "HAC_UNREACHABLE"
  | "HAC_TLS"
  | "HAC_TIMEOUT"
  | "HAC_AUTH"
  | "HAC_ERROR"
  | "HAC_QUERY_ERROR"
  | "NOT_FOUND"
  | "LOG_UNAVAILABLE"
  | "INTERNAL";

export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ToolError";
  }
}

export interface NormalizedError {
  code: ErrorCode;
  message: string;
}

/**
 * Convert anything thrown into a client-safe error. The redactor is applied to the final message so
 * that a credential echoed by an upstream error body can never leave the process.
 */
export function normalizeError(error: unknown, redact: (text: string) => string = (t) => t): NormalizedError {
  if (error instanceof ToolError) {
    return { code: error.code, message: redact(error.message) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message: redact(`Unexpected error: ${message}`.slice(0, 500)) };
}
