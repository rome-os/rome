// Shared by the actions that run one connection kind's tool, such as
// `discord_read_messages`. Each action keeps its own schema and description,
// as its platform reads; only the call to the host is shared. Prototype.

import { getCurrentActionContext } from "@rome-os/app-runtime";
import type { ActionResult, ChannelsService } from "@rome-os/app-runtime";

/**
 * Run `tool` on the connection behind `channel`, else behind the channel the
 * run was woken on. `chatField` names the argument that holds the chat, which
 * defaults to the one the run was woken in.
 */
export async function runConnectionTool(
  channels: ChannelsService,
  tool: string,
  args: Record<string, unknown>,
  chatField: string,
): Promise<ActionResult> {
  const context = getCurrentActionContext()?.channelContext;
  const channel = (typeof args.channel === "string" && args.channel) || context?.channel;
  if (!channel) {
    return { status: "error", error: "Name the channel: this run was not woken in a chat." };
  }
  if (!channels.callTool) return { status: "error", error: "This host gives no connection tools." };
  const { channel: _channel, ...rest } = args;
  const chat = rest[chatField] ?? (channel === context?.channel ? context?.threadId : undefined);
  try {
    const data = await channels.callTool(channel, tool, {
      ...rest,
      ...(chat === undefined ? {} : { [chatField]: chat }),
    });
    return { status: "ok", data };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
