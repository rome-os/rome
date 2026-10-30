import type { ChangedFile } from "../../lib/changes.js";

export function dreamAppChangeGroups(files: ChangedFile[]) {
  const appFiles = files.filter((file) => file.area === "other" || file.area === "skill");
  return {
    touchedByPractice: appFiles.filter((file) => file.attribution === "practice"),
    sourceUnknown: appFiles.filter((file) => file.attribution === "unattributed"),
    other: appFiles.filter((file) => file.attribution === null),
  };
}
