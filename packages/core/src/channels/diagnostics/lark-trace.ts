import { defaultHttpInstance, type HttpInstance } from "@larksuiteoapi/node-sdk";
import { traceImApi, type ImPlatform } from "./api-trace.js";

export function traceLarkHttp(
  platform: ImPlatform,
  client: HttpInstance = defaultHttpInstance,
): HttpInstance {
  return new Proxy(client, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (
        typeof method !== "function" ||
        !["request", "get", "post", "put", "patch", "delete", "head", "options"].includes(
          String(property),
        )
      )
        return method;
      return (...args: unknown[]) =>
        traceImApi(platform, "sdk", { method: String(property), arguments: args }, async () =>
          Reflect.apply(method, target, args),
        );
    },
  });
}
