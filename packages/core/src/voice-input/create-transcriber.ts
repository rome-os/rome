import type { Config } from "../config.js";
import { createSonioxTranscriber } from "./soniox.js";
import type { Transcriber } from "./transcriber.js";

/** The instance's transcriber, or null when no provider is configured. */
export function createTranscriber(config: Config["voiceInput"]): Transcriber | null {
  if (!config) return null;
  switch (config.provider) {
    case "soniox":
      return createSonioxTranscriber(config);
  }
}
