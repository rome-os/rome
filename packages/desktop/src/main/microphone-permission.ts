import type { Session } from "electron";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a page may have the microphone: only the main frame of the Rome
 * this launch opened, and only audio. The camera, screen capture and every
 * other origin are refused.
 */
export function allowsMedia(
  request: { url: string; isMainFrame: boolean; mediaTypes: readonly string[] },
  instanceOrigin: string | null,
): boolean {
  return (
    request.isMainFrame &&
    instanceOrigin !== null &&
    originOf(request.url) === instanceOrigin &&
    request.mediaTypes.length > 0 &&
    request.mediaTypes.every((type) => type === "audio")
  );
}

/**
 * Electron's answer for a permission no handler decides: it refuses
 * synchronous clipboard reads and grants the rest. Installing a handler
 * replaces that answer, so the handlers below repeat it.
 */
const REFUSED_BY_DEFAULT = new Set(["deprecated-sync-clipboard-read"]);

/** Screen, window and tab capture, which no page in the app gets. */
const DISPLAY_CAPTURE = "display-capture";

/** The permission handlers' answer for anything but the microphone. */
export function allowsOther(permission: string): boolean {
  return permission !== DISPLAY_CAPTURE && !REFUSED_BY_DEFAULT.has(permission);
}

type PermissionSession = Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">;

/**
 * Gives the open Rome's voice input the microphone, and nothing else media.
 * `instanceOrigin` is read at each request, since the Rome the window opens
 * can change; null refuses the microphone to every page.
 */
export function installMicrophonePermission(
  session: PermissionSession,
  instanceOrigin: () => string | null,
): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "media") return callback(allowsOther(permission));
    const media = details as Electron.MediaAccessPermissionRequest;
    callback(
      allowsMedia(
        {
          url: media.requestingUrl,
          isMainFrame: media.isMainFrame,
          mediaTypes: media.mediaTypes ?? [],
        },
        instanceOrigin(),
      ),
    );
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (permission !== "media") return allowsOther(permission);
    return allowsMedia(
      {
        url: details.securityOrigin ?? requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : [],
      },
      instanceOrigin(),
    );
  });
}
