// Personal WeChat: the guardian's own signed-in WeChat, through the client
// Rome runs in this container. It is opt-in, by config `wechatUserEnabled`.
// Nothing in Connections imports it, so leaving it out of the wiring leaves
// every other kind working. Vocabulary: docs/domains/connections.md.

import type { KindMount } from "../../kind-mount.js";
import { createWechatUserDescriptor } from "./descriptor.js";
import { wechatAppRoutes } from "./http/wechat-app.js";
import { WechatApp } from "./wechat-app.js";
import type { WechatUserRuntime } from "./wechat-user.js";

export { WECHAT_USER_KIND } from "./descriptor.js";
export {
  isWechatUserSessionRejected,
  type WechatUserChat,
  type WechatUserMessage,
  WechatUserReader,
  WechatUserRuntime,
  WechatUserStorePending,
} from "./wechat-user.js";

export interface WechatUserDeps {
  /** The client runtime, present only when config `wechatUserEnabled` is on.
   *  The channel list reads the account through the same one. */
  runtime?: WechatUserRuntime;
}

/**
 * The connection, offered only with a runtime, and the routes of the WeChat
 * app on its own desktop. The routes answer even without a runtime, so the
 * /desktop/wechat page can say WeChat is off.
 */
export function wechatUser(deps: WechatUserDeps): KindMount {
  // The client runs in this container and recovers its store key with a local
  // debugger, so it needs no host execution, only the container's own
  // capability to ptrace the client it launches.
  const wechatApp = deps.runtime ? new WechatApp(deps.runtime) : null;
  return {
    descriptor: deps.runtime ? createWechatUserDescriptor({ runtime: deps.runtime }) : null,
    routes: wechatAppRoutes({ wechatApp }),
  };
}
