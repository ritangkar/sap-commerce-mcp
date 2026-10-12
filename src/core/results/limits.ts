/** Output-size control. Arrays named below are shrunk first when a result exceeds the budget. */
const SHRINKABLE = ["rows", "lines", "entries", "attributes", "subtypes", "cronjobs"] as const;

export interface LimitedResult {
  data: unknown;
  truncated: boolean;
}

export function limitResultSize(data: unknown, maxChars: number): LimitedResult {
  if (JSON.stringify(data).length <= maxChars) return { data, truncated: false };
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { data: { truncated: true, note: "Result exceeded the size limit and was dropped." }, truncated: true };
  }

  const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of SHRINKABLE) {
    const value = copy[key];
    if (!Array.isArray(value)) continue;
    let keep = value.length;
    while (keep > 0 && JSON.stringify({ ...copy, [key]: value.slice(0, keep) }).length > maxChars) {
      keep = Math.floor(keep / 2);
    }
    copy[key] = value.slice(0, keep);
    copy.truncated = true;
    copy.note = `Result exceeded ${maxChars} characters; ${key} was cut to the first ${keep} of ${value.length} entries.`;
    if (JSON.stringify(copy).length <= maxChars) return { data: copy, truncated: true };
  }
  return { data: { truncated: true, note: `Result exceeded ${maxChars} characters and was dropped.` }, truncated: true };
}

/** Clip a serialized tool result for the model context (the UI/MCP still gets the full capped result). */
export function clipForModel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} characters to fit the model context]`;
}
