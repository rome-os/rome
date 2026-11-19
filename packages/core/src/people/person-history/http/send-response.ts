import { sendRefusalMessage, type SendRefusal } from "@rome/api-types/people";
import type { Context } from "hono";
import type { SendResult } from "../../../chats/send.js";

/** The one answer every send route gives, so the dashboard reads one shape. */
export function respondToSend(c: Context, result: SendResult) {
  if (result.ok) return c.json(result.sent, 200);
  if ("invalid" in result) return c.json({ error: result.invalid }, 400);
  if ("error" in result) return c.json({ error: result.error }, 502);
  return c.json(
    { error: sendRefusalMessage(result.send), send: result.send } satisfies SendRefusal,
    409,
  );
}
