import { open, stat } from "node:fs/promises";
import { ToolError } from "../core/errors.js";

export interface LogTailResult {
  path: string;
  lines: string[];
  matched: number;
  scannedBytes: number;
  fileBytes: number;
  filter?: string;
}

export interface LogPort {
  tail(options: { lines: number; contains?: string }): Promise<LogTailResult>;
}

/** Only the last 4 MiB of the file are ever read. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * Reads the tail of the one log file configured via HAC_LOG_PATH. The path comes from configuration,
 * never from tool arguments. The file is opened read-only.
 */
export class LogReader implements LogPort {
  constructor(private readonly path: string | undefined, private readonly redact: (text: string) => string = (t) => t) {}

  async tail({ lines, contains }: { lines: number; contains?: string }): Promise<LogTailResult> {
    if (!this.path) {
      throw new ToolError("LOG_UNAVAILABLE", "HAC_LOG_PATH is not set. Point it at the local console log file to use logs_tail.");
    }
    let info;
    try {
      info = await stat(this.path);
    } catch {
      throw new ToolError("LOG_UNAVAILABLE", `Log file not found or not readable: ${this.path}`);
    }
    if (!info.isFile()) throw new ToolError("LOG_UNAVAILABLE", `HAC_LOG_PATH is not a regular file: ${this.path}`);

    const length = Math.min(info.size, MAX_SCAN_BYTES);
    const handle = await open(this.path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }

    let all = text.replace(/\r\n/g, "\n").split("\n");
    // The first line is probably cut in half when we started mid-file.
    if (info.size > length) all = all.slice(1);
    all = all.filter((l) => l.length > 0);

    const needle = contains?.toLowerCase();
    const matched = needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all;
    return {
      path: this.path,
      lines: matched.slice(-lines).map((l) => this.redact(l.length > 2000 ? `${l.slice(0, 2000)}…` : l)),
      matched: matched.length,
      scannedBytes: length,
      fileBytes: info.size,
      ...(contains ? { filter: contains } : {})
    };
  }
}
