import type { RESTOptions } from "discord.js";
import { traceImApi } from "./api-trace.js";

export function traceDiscordRequest(
  request: RESTOptions["makeRequest"],
): RESTOptions["makeRequest"] {
  return (url, init) =>
    traceImApi(
      "discord",
      "http",
      { url, method: init.method, headers: init.headers, body: init.body },
      () => request(url, init),
      (response, recordBody) => {
        // discord.js uses an undici stream without clone(). Observe SDK consumption
        // rather than reading that stream before the SDK can handle a rate limit.
        for (const method of ["json", "text"] as const) {
          const original = response[method].bind(response);
          Object.defineProperty(response, method, {
            configurable: true,
            value: async () => {
              const body = await original();
              recordBody(body);
              return body;
            },
          });
        }
        return { status: response.status, headers: Object.fromEntries(response.headers) };
      },
    );
}
