import { z } from "zod";

/**
 * The WeChat app on WeChat's own desktop, as `GET /api/wechat/app` reports it.
 *   unavailable — WeChat is not enabled on this instance
 *   absent      — the client is not downloaded yet
 *   installing  — downloading and unpacking it, then opening it
 *   stopped     — downloaded, but not running
 *   starting    — opening it on its desktop
 *   running     — running, so its desktop has something to show
 */
export const wechatAppStateSchema = z.enum([
  "unavailable",
  "absent",
  "installing",
  "stopped",
  "starting",
  "running",
]);

export const wechatAppStatusSchema = z.object({
  state: wechatAppStateSchema,
  /** Why the last install or start failed. Cleared when the next one begins. */
  error: z.string().optional(),
  /** The running client is on the shared desktop, `/desktop`, not WeChat's own. */
  sharedDesktop: z.literal(true).optional(),
});

export type WechatAppState = z.infer<typeof wechatAppStateSchema>;
export type WechatAppStatus = z.infer<typeof wechatAppStatusSchema>;
