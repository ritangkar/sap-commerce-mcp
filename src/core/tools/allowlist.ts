/**
 * The complete, auditable list of tools this project exposes (MCP, web API and AI providers alike).
 * A test asserts that the registry contains exactly these names. Adding a tool means editing this list
 * deliberately, which makes the change visible in review.
 */
export const APPROVED_TOOL_NAMES = ["flexible_search", "type_info", "config_get", "logs_tail", "cronjob"] as const;
export type ApprovedToolName = (typeof APPROVED_TOOL_NAMES)[number];
