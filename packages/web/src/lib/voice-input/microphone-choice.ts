// Which microphone voice input records from, kept in this browser. Device ids
// belong to one browser profile and one origin, so the choice cannot follow
// the guardian to another device.

import { readStored, writeStored } from "@/lib/stored-preference";

const KEY = "rome.voiceInput.microphone";
// The chosen microphone's name. A browser that allows the microphone for one
// page load at a time gives it a new device id on each load, so the name finds
// it again.
const LABEL_KEY = "rome.voiceInput.microphoneLabel";

export interface MicrophoneOption {
  id: string;
  label: string;
}

/** The chosen microphone's device id, or null for the system default. */
export function chosenMicrophone(): string | null {
  return readStored(KEY) || null;
}

/**
 * Keeps `option` as the microphone to record from; null goes back to the
 * system default. Returns the device id storage now holds, which is the
 * earlier one when storage refuses the write (private mode, full).
 */
export function chooseMicrophone(option: MicrophoneOption | null): string | null {
  writeStored(KEY, option?.id || null);
  writeStored(LABEL_KEY, option?.label || null);
  return chosenMicrophone();
}

/**
 * The chosen microphone among `options`: the one with its device id, else the
 * one with its name. Null when neither is there.
 */
export function findChosenMicrophone(options: MicrophoneOption[]): MicrophoneOption | null {
  const id = chosenMicrophone();
  if (!id) return null;
  const byId = options.find((option) => option.id === id);
  if (byId) return byId;
  const label = readStored(LABEL_KEY);
  const byLabel = label ? options.find((option) => option.label === label) : undefined;
  return byLabel ?? null;
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
