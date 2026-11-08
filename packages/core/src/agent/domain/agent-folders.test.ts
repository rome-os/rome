import { describe, expect, it } from "@rstest/core";
import { projectPath } from "./agent-folders.js";

const folders = { defaultWorkingDir: "/rome/projects/default", projectsFolder: "/rome/projects" };

describe("projectPath", () => {
  it("gives a working directory's path under the projects folder", () => {
    expect(projectPath(folders, "/rome/projects/default")).toBe("default");
    expect(projectPath(folders, "/rome/projects/landingpage/content")).toBe("landingpage/content");
  });

  it("gives no path for the projects folder itself or a folder outside it", () => {
    expect(projectPath(folders, "/rome/projects")).toBeNull();
    expect(projectPath(folders, "/var/data/field-notes")).toBeNull();
    expect(projectPath(folders, "/rome/projects-old/a")).toBeNull();
  });
});
