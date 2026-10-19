import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import {
  getRecapSettings,
  isRecapAudioSpeed,
  isRecapThreshold,
  setRecapSettings,
} from "../settings.js";

function readJsonBody(request: RomeAppApiRequest): unknown {
  if (!request.body || request.body.byteLength === 0) return null;
  const text = new TextDecoder().decode(request.body);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

class RecapApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const route = request.path.join("/");

    if (request.method === "GET" && request.path.length === 0) {
      return Response.json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        status: "ok",
      });
    }

    if (request.method === "GET" && route === "settings") {
      return Response.json(await getRecapSettings(this.ctx.repositories.settings));
    }

    if (request.method === "PUT" && route === "settings") {
      const payload = readJsonBody(request);
      if (payload === undefined) {
        return Response.json({ error: "invalid_json" }, { status: 400 });
      }

      // A cached older web bundle omits `enabled`, so keep the stored value rather than reset it.
      const enabled =
        (payload as { enabled?: unknown } | null)?.enabled ??
        (await getRecapSettings(this.ctx.repositories.settings)).enabled;
      if (typeof enabled !== "boolean") {
        return Response.json({ error: "enabled_boolean_required" }, { status: 400 });
      }

      const createAudio = (payload as { createAudio?: unknown } | null)?.createAudio;
      if (typeof createAudio !== "boolean") {
        return Response.json({ error: "createAudio_boolean_required" }, { status: 400 });
      }

      const threshold = (payload as { threshold?: unknown } | null)?.threshold;
      if (!isRecapThreshold(threshold)) {
        return Response.json({ error: "threshold_invalid" }, { status: 400 });
      }

      const audioSpeed = (payload as { audioSpeed?: unknown } | null)?.audioSpeed;
      if (!isRecapAudioSpeed(audioSpeed)) {
        return Response.json({ error: "audio_speed_invalid" }, { status: 400 });
      }

      const settings = { enabled, createAudio, threshold, audioSpeed };
      await setRecapSettings(this.ctx.repositories.settings, settings);
      return Response.json(settings);
    }

    return Response.json(
      {
        error: "not_found",
        appId: this.ctx.app.id,
        message: `Unknown recap API route: /${route}`,
      },
      { status: 404 },
    );
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new RecapApiHandler(ctx);
}
