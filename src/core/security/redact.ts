/**
 * Secret redaction. Best effort and deliberately over-inclusive: it is better to mask a harmless value
 * than to leak a credential into an MCP client, a browser or a model provider.
 */
export const MASK = "****";

const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|pwd|secret|token|key|credential|auth|private|cert|salt|signature|cookie|session/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

const SENSITIVE_COLUMN = /pass(word|wd|phrase)?|pwd|secret|token|credential|api[_-]?key|private[_-]?key|encoded|hash|salt/i;

export function isSensitiveColumn(name: string): boolean {
  return SENSITIVE_COLUMN.test(name);
}

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // key=value / key: value / "key":"value" for secret-like keys
  [
    /(["']?\b[\w.-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|credential|authorization|private[_-]?key)[\w.-]*["']?\s*[=:]\s*)(?!(?:Bearer|Basic)\b)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"']+)/gi,
    `$1${MASK}`
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/(\/\/[^\s/:@]+:)[^\s/@]+@/g, `$1${MASK}@`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK]
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Build a redactor that also removes the exact secret values this process knows about. */
export function createRedactor(knownSecrets: Array<string | undefined>): (text: string) => string {
  const secrets = knownSecrets.filter((s): s is string => typeof s === "string" && s.length >= 4);
  return (text: string) => {
    let out = text;
    for (const secret of secrets) {
      out = out.split(secret).join(MASK);
    }
    return redactText(out);
  };
}

export function redactConfigValue(key: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (isSensitiveKey(key)) return MASK;
  return redactText(value);
}
