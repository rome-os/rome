/** A tool's name without its provider or group prefix (`mcp__rome__say`, `core:say`). */
export function bareTool(tool: string): string {
  const afterMcp = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return afterMcp.slice(afterMcp.lastIndexOf(":") + 1).toLowerCase();
}
