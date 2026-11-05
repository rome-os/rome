import { describe, expect, it, rs } from "@rstest/core";
import type { GithubHook, GithubHookClient } from "../../../actions/github-hook-client.js";
import { describeGithubError, ensureGithubEvent, githubTargetFromFilter } from "./ensure.js";

const RELAY_URL = "https://relay.example/h/mbox";

function makeClient(hooks: GithubHook[]) {
  const ops: string[] = [];
  const client: GithubHookClient = {
    listHooks: async () => {
      ops.push("list");
      return hooks;
    },
    createHook: async (input) => {
      ops.push(`create:${input.events.join(",")}`);
      return { id: 9, events: input.events, config: input.config };
    },
    updateHook: async (hookId, input) => {
      ops.push(`update:${hookId}:${input.events.join(",")}`);
      return { id: hookId, events: input.events, config: input.config };
    },
    deleteHook: async (hookId) => {
      ops.push(`delete:${hookId}`);
    },
  };
  return { client, ops };
}

function ensure(
  hooks: GithubHook[],
  event: string,
  dryRun: boolean,
  names: { asked: string; github: string } = { asked: "acme/widgets", github: "acme/widgets" },
) {
  const { client, ops } = makeClient(hooks);
  const secret = rs.fn(async () => "s3cret");
  const run = ensureGithubEvent({
    client,
    targetName: names.asked,
    targetField: "repository.full_name",
    canonicalName: async () => names.github,
    relayDepositUrl: RELAY_URL,
    legacyInstanceUrl: null,
    event,
    dryRun,
    secret,
  });
  return { run, ops, secret };
}

describe("ensureGithubEvent", () => {
  const relayHook = (events: string[], active?: boolean): GithubHook => ({
    id: 1,
    events,
    active,
    config: { url: RELAY_URL },
  });

  it("dry run reports active when Rome's hook already delivers the event", async () => {
    const { run, ops, secret } = ensure(
      [relayHook(["push", "workflow_run"])],
      "workflow_run",
      true,
    );
    expect(await run).toBe("active");
    expect(ops).toEqual(["list"]);
    expect(secret).not.toHaveBeenCalled();
  });

  it("dry run reports inactive and changes nothing when the event is missing", async () => {
    const other: GithubHook = { id: 2, events: ["workflow_run"], config: { url: "https://x" } };
    const { run, ops, secret } = ensure(
      [relayHook(["push"]), relayHook(["*"], false), other],
      "workflow_run",
      true,
    );
    expect(await run).toBe("inactive");
    expect(ops).toEqual(["list"]);
    expect(secret).not.toHaveBeenCalled();
  });

  it("reuses a hook that delivers every event", async () => {
    const { run, ops } = ensure([relayHook(["*"])], "check_suite", false);
    expect(await run).toBe("existing");
    expect(ops).toEqual(["list"]);
  });

  it("merges the event into Rome's existing hook", async () => {
    const { run, ops } = ensure([relayHook(["issues", "pull_request"])], "workflow_run", false);
    expect(await run).toBe("created");
    expect(ops).toEqual(["list", "list", "update:1:issues,pull_request,workflow_run"]);
  });

  it("creates Rome's hook when there is none", async () => {
    const { run, ops, secret } = ensure([], "workflow_run", false);
    expect(await run).toBe("created");
    expect(ops).toEqual(["list", "list", "create:workflow_run"]);
    expect(secret).toHaveBeenCalledTimes(1);
  });
});

describe("ensureGithubEvent with a name in the wrong case", () => {
  it("refuses before touching the webhook and names GitHub's spelling", async () => {
    for (const dryRun of [false, true]) {
      const { run, ops, secret } = ensure([], "workflow_run", dryRun, {
        asked: "Acme/Widgets",
        github: "acme/widgets",
      });
      await expect(run).rejects.toThrow(
        'GitHub spells Acme/Widgets as acme/widgets. Filter repository.full_name on "acme/widgets"',
      );
      expect(ops).toEqual([]);
      expect(secret).not.toHaveBeenCalled();
    }
  });
});

describe("githubTargetFromFilter", () => {
  it("reads the repo, else the org, from the filter", () => {
    expect(
      githubTargetFromFilter([
        { field: "organization.login", equals: "acme" },
        { field: "repository.full_name", equals: "acme/widgets" },
      ]),
    ).toEqual({ repo: "acme/widgets" });
    expect(githubTargetFromFilter([{ field: "organization.login", equals: "acme" }])).toEqual({
      org: "acme",
    });
    expect(githubTargetFromFilter([{ field: "repository.full_name", equals: "widgets" }])).toBe(
      null,
    );
    expect(githubTargetFromFilter([{ field: "action", equals: "completed" }])).toBe(null);
  });
});

describe("describeGithubError", () => {
  it("names the admin requirement when GitHub answers 403 or 404", () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    expect(describeGithubError("acme/widgets", err)).toBe(
      "GitHub refused the webhook on acme/widgets: admin access is required, or it does not exist (HTTP 404)",
    );
  });
});
