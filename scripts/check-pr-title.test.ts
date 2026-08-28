import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "@rstest/core";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./check-pr-title.sh", import.meta.url));

async function check(title: string): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync(script, [], { env: { ...process.env, PR_TITLE: title } });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
  }
}

describe("check-pr-title.sh", () => {
  it.each([
    "feat: add the connections list",
    "fix(web): keep the list mounted while refetching",
    "feat(app-runtime)!: drop the legacy action envelope",
    "feat!: drop the legacy action envelope",
    "chore: release main",
    "refactor(core/db): fold the repository helpers together",
    "docs: explain the release flow",
    "fix: handle a title: with a colon in the subject",
    "feat:",
    "feat: ",
    "  fix(web): tolerate a title padded with whitespace  ",
  ])("accepts %j", async (title) => {
    expect((await check(title)).code).toBe(0);
  });

  it.each([
    "add the connections list",
    "Add the connections list",
    "[feat] add the connections list",
    "feature: add the connections list",
    "feat add the connections list",
    "feat:add the connections list",
    "feat():  add the connections list",
    "feat(): add the connections list",
    "feat(my scope): add the connections list",
    "feat(scope@x): add the connections list",
    "feat:  add the connections list",
    "feat:\tadd the connections list",
    "feat: add the connections list\nand a second line",
    "\nfeat: add the connections list",
    "feat: add the connections list\n",
    "feat: add the connections list\r",
    "feat!:",
    "feat!: ",
    "fix(app-runtime)!:",
    "",
    "   ",
  ])("rejects %j", async (title) => {
    expect((await check(title)).code).toBe(1);
  });

  it("names the lower-case rule when only the casing is wrong", async () => {
    const { code, stderr } = await check("Feat(Web): add the connections list");
    expect(code).toBe(1);
    expect(stderr).toContain("lower-case");
  });

  it.each([
    "feat(): add the list",
    "feat(my scope): add the list",
    "feat(scope@x): add the list",
  ])("blames the scope, not the casing, for %j", async (title) => {
    const { stderr } = await check(title);
    expect(stderr).toContain("scope must be a lower-case identifier");
  });

  it.each([
    "feat!:",
    "fix(app-runtime)!:",
  ])("explains the lost breaking bump for %j", async (title) => {
    const { stderr } = await check(title);
    expect(stderr).toContain("a breaking change needs a subject");
  });

  it("names the spacing rule when the subject is padded", async () => {
    const { stderr } = await check("feat:  add the connections list");
    expect(stderr).toContain("exactly one space");
  });

  it.each([
    "\nfeat: add the list",
    "feat: add the list\n",
    "feat: add the list\r",
  ])("keeps the single-line rule for an edge line break in %j", async (title) => {
    const { stderr } = await check(title);
    expect(stderr).toContain("single line");
  });

  it("names the single-line rule for a multi-line title", async () => {
    const { stderr } = await check("feat: add the list\nand a second line");
    expect(stderr).toContain("single line");
  });

  it("points a failing author at the spec and the allowed types", async () => {
    const { stderr } = await check("nope");
    expect(stderr).toContain("https://www.conventionalcommits.org/en/v1.0.0/");
    expect(stderr).toContain("feat, fix");
    expect(stderr).toContain("docs/releases.md");
  });
});
