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
  dashboardUrl: string,
): boolean {
  const dashboard = originOf(dashboardUrl);
  return (
    request.isMainFrame &&
    dashboard !== null &&
    originOf(request.url) === dashboard &&
    request.mediaTypes.length > 0 &&
    request.mediaTypes.every((type) => type === "audio")
  );
}

/**
 * Gives the dashboard's voice input the microphone and nothing else media.
 * Other permissions keep Electron's default, which grants them.
 */
export function installMicrophonePermission(session: Session, dashboardUrl: () => string): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "media") return callback(true);
    const media = details as Electron.MediaAccessPermissionRequest;
    callback(
      allowsMedia(
        {
          url: media.requestingUrl,
          isMainFrame: media.isMainFrame,
          mediaTypes: media.mediaTypes ?? [],
        },
        dashboardUrl(),
      ),
    );
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (permission !== "media") return true;
    return allowsMedia(
      {
        url: details.securityOrigin ?? requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : [],
      },
      dashboardUrl(),
    );
  });
}
