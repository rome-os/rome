interface ResolveInitialSelectedFolderPathInput {
  initialSelectedFolderPath?: string;
  isDesktopViewport: boolean;
}

export function resolveInitialSelectedFolderPath({
  initialSelectedFolderPath,
  isDesktopViewport,
}: ResolveInitialSelectedFolderPathInput): string | null {
  if (!initialSelectedFolderPath || !isDesktopViewport) {
    return null;
  }
  return initialSelectedFolderPath;
}
