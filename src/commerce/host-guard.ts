import { ToolError } from "../core/errors.js";

/**
 * This tool is for local development only. HAC hosts must be loopback or private-network addresses
 * (localhost, 127.x, ::1, 10.x, 172.16-31.x, 192.168.x, *.local, *.localhost). There is intentionally
 * no override switch.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1") return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((octet) => octet > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

export function assertAllowedHacUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("CONFIG_MISSING", `HAC_URL must use http or https (got "${url.protocol}").`);
  }
  if (url.username || url.password) {
    throw new ToolError("CONFIG_MISSING", "HAC_URL must not contain embedded credentials; use HAC_USER and HAC_PASS.");
  }
  if (!isPrivateHost(url.hostname)) {
    throw new ToolError(
      "CONFIG_MISSING",
      `Refusing HAC host "${url.hostname}": this tool only connects to local/private development hosts (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, *.local).`
    );
  }
}
