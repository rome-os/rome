// Which microphone voice input records from, kept in this browser. Device ids
// belong to one browser profile and one origin, so the choice cannot follow
// the guardian to another device.

const KEY = "rome.voiceInput.microphone";

export interface MicrophoneOption {
  id: string;
  label: string;
}

/** The chosen microphone's device id, or null for the system default. */
export function chosenMicrophone(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/** Keeps `id` as the microphone to record from; null goes back to the system default. */
export function chooseMicrophone(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage refused (private mode, full): the system default stays in use.
  }
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
