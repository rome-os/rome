import { createSonioxSpeaker } from "./soniox-speaker.js";
import type { Speaker } from "./speaker.js";

/** The adapter for `provider`, by its lower-case name, or null for one Rome has no adapter for. */
export function speakerFor(
  provider: string,
  options: {
    token: string;
    url?: string;
    model?: string;
    voice?: string;
    language?: string;
    speed?: number;
  },
): Speaker | null {
  switch (provider.toLowerCase()) {
    case "soniox":
      return createSonioxSpeaker(options);
    default:
      return null;
  }
}
