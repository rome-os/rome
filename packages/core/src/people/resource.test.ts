import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as pathsModule from "../paths.js" with { rstest: "importActual" };

// The profile dir the memory tree hangs off, redirected at a temp dir so a
// profile written here is this test's and not the machine's.
const mockPaths = rs.hoisted(() => ({ profileDir: "/tmp/rome-test-profile" }));

rs.mock("../paths.js", () => ({
  ...pathsModule,
  getProfileDir: rs.fn(() => mockPaths.profileDir),
}));

import { readPeople } from "./resource.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";

// What `PersonResource.memoryPath` answers: the profile Rome wrote about
// someone, addressed the way the memory file browser addresses it. The rest of
// the serialization is exercised through the routes (`../api/routes/people.test.ts`).

describe("A person's memory profile", () => {
  let root: string;
  let testDb: TestDb;
  let deps: TestDeps;

  const relationshipDir = () => join(mockPaths.profileDir, "memory", "relationship");
  const writeProfile = (fileName: string) => {
    mkdirSync(relationshipDir(), { recursive: true });
    writeFileSync(join(relationshipDir(), fileName), "# Profile\n");
  };
  const memoryPathOf = async (displayName: string) =>
    (await readPeople(deps)).find((person) => person.displayName === displayName)?.memoryPath;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "rome-person-memory-"));
    mockPaths.profileDir = join(root, "profile");
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
  });

  afterEach(() => {
    testDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("answers the path stored on the row, which is how the guardian's is addressed", async () => {
    writeProfile("GUARDIAN.md");
    expect(await memoryPathOf("Guardian")).toBe("memory/relationship/GUARDIAN.md");
  });

  it("answers the convention every other profile is written under", async () => {
    const id = await deps.personMappingRepo.create({
      displayName: "Wei Chen",
      bondLevel: "inner-circle",
      approved: true,
    });
    writeProfile(`${id}.md`);

    expect(await memoryPathOf("Wei Chen")).toBe(`memory/relationship/${id}.md`);
  });

  it("answers none for a profile stored outside the relationship dir", async () => {
    // The dashboard opens what this answers under the memory root, and only
    // this one directory holds profiles — so a row pointing anywhere else falls
    // back to the convention rather than handing out a path to link against.
    const id = await deps.personMappingRepo.create({
      displayName: "Wei Chen",
      bondLevel: "inner-circle",
      approved: true,
    });
    await deps.personMappingRepo.updatePerson(id, { profilePath: "memory/IDENTITY.md" });
    mkdirSync(join(mockPaths.profileDir, "memory"), { recursive: true });
    writeFileSync(join(mockPaths.profileDir, "memory", "IDENTITY.md"), "# Identity\n");

    expect(await memoryPathOf("Wei Chen")).toBe(null);
  });

  it("answers none for a person nobody has written a profile about", async () => {
    // Creating a person writes no profile, so this is the ordinary case rather
    // than a broken one — and a path served for it would be a link to nothing.
    await deps.personMappingRepo.create({
      displayName: "Nadia Petrova",
      bondLevel: "acquaintance",
      approved: true,
    });

    expect(await memoryPathOf("Nadia Petrova")).toBe(null);
    expect(await memoryPathOf("Guardian")).toBe(null);
  });
});
