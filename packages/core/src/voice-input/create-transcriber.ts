import { createSonioxTranscriber } from "./soniox.js";
import type { Transcriber } from "./transcriber.js";

/** The adapter for `provider`, by its lower-case name, or null for one Rome has no adapter for. */
export function transcriberFor(
  provider: string,
  options: { apiKey: string; url?: string; model?: string },
): Transcriber | null {
  switch (provider.toLowerCase()) {
    case "soniox":
      return createSonioxTranscriber(options);
    default:
      return null;
  }
}
