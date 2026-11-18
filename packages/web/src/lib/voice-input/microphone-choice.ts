// Which microphone voice input records from, kept in this browser. Device ids
// belong to one browser profile and one origin, so the choice cannot follow
// the guardian to another device. Voice input records from the chosen
// microphone while it is connected; once the browser lists the microphones
// without it, the choice is cleared and voice input uses the system default.

import { readStored, writeStored } from "@/lib/stored-preference";

const KEY = "rome.voiceInput.microphone";

export interface MicrophoneOption {
  id: string;
  label: string;
}

/**
 * The chosen microphone, or null for the system default. It is stored as one
 * JSON record; a choice saved before names were kept is a bare device id,
 * read with an empty name.
 */
export function chosenMicrophone(): MicrophoneOption | null {
  const raw = readStored(KEY);
  if (!raw) return null;
  try {
    const stored: unknown = JSON.parse(raw);
    if (stored && typeof stored === "object") {
      const { id, label } = stored as Record<string, unknown>;
      if (typeof id === "string" && id)
        return { id, label: typeof label === "string" ? label : "" };
    }
  } catch {
    // A bare device id.
  }
  return { id: raw, label: "" };
}

/**
 * Keeps `option` as the microphone to record from; null goes back to the
 * system default. Returns the choice storage now holds, which is the earlier
 * one when storage refuses the write (private mode, full).
 */
export function chooseMicrophone(option: MicrophoneOption | null): MicrophoneOption | null {
  writeStored(KEY, option ? JSON.stringify({ id: option.id, label: option.label }) : null);
  return chosenMicrophone();
}

/**
 * `chosen` among `options`: the one with its device id, else the one with its
 * name, since a browser that allows the microphone for one page load at a
 * time gives it a new id on each load. Null when it is not connected.
 */
export function findMicrophone(
  chosen: MicrophoneOption | null,
  options: MicrophoneOption[],
): MicrophoneOption | null {
  if (!chosen) return null;
  return (
    options.find((option) => option.id === chosen.id) ??
    (chosen.label ? options.find((option) => option.label === chosen.label) : undefined) ??
    null
  );
}

/**
 * The microphones this browser can record from, or null while the browser
 * hides their names, which it does until the microphone has been allowed.
 * Chrome's own "default" and "communications" entries are left out, since
 * the system default is its own choice.
 */
export async function listMicrophones(): Promise<MicrophoneOption[] | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(
    (device) =>
      device.kind === "audioinput" &&
      device.deviceId !== "default" &&
      device.deviceId !== "communications",
  );
  if (inputs.some((device) => !device.label)) return null;
  return inputs.map((device) => ({ id: device.deviceId, label: device.label }));
}

/** Asks the browser for the microphone and releases it at once, so it names its microphones. */
export async function revealMicrophones(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
}
