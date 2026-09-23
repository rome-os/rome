import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../../types.js";
import type { ModelSessionParams } from "../../core/agent-runner.js";
import { SettingsRepository } from "../../db/repositories/settings.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import {
  discoverPiModels,
  PI_PROTOTYPE_CREDENTIAL_KEY_PREFIX,
  PiChildPrototypeProvider,
  PiPrototypeCredentialStore,
  redactPiPrototypeCredentialSetting,
  runIsolatedPiChild,
  type PiChildEvent,
} from "./pi-child-prototype.js";

const FIXTURE_CREDENTIAL = "fixture-only-credential";

function sessionParams(model: string): ModelSessionParams {
  return {
    model,
    systemPrompt: "fixture system prompt",
    sessionId: "fixture-session",
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => undefined,
    executeSubagent: async () => undefined,
  };
}

async function collect(operation: AsyncIterable<PiChildEvent>): Promise<PiChildEvent[]> {
  const events: PiChildEvent[] = [];
  for await (const event of operation) events.push(event);
  return events;
}

describe("isolated Pi child prototype", () => {
  let testDb: TestDb;
  let credentials: PiPrototypeCredentialStore;
  const previousEnvironment = { ...process.env };

  beforeEach(() => {
    testDb = createTestDb();
    credentials = new PiPrototypeCredentialStore(new SettingsRepository(testDb.db));
  });

  afterEach(() => {
    testDb.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
  });

  it("durably reloads provider-scoped Rome credentials without returning them", async () => {
    const saved = await credentials.save("anthropic", `  ${FIXTURE_CREDENTIAL}  `);
    await credentials.save("openai", "other-fixture-value");
    const reloaded = new PiPrototypeCredentialStore(new SettingsRepository(testDb.db));

    expect(saved).toMatchObject({ provider: "anthropic", configured: true });
    expect(JSON.stringify(saved)).not.toContain(FIXTURE_CREDENTIAL);
    expect(await reloaded.loadForOperation("anthropic")).toBe(FIXTURE_CREDENTIAL);
    expect(JSON.stringify(await reloaded.status("anthropic"))).not.toContain(FIXTURE_CREDENTIAL);
    const raw = await new SettingsRepository(testDb.db).get(
      `${PI_PROTOTYPE_CREDENTIAL_KEY_PREFIX}anthropic`,
    );
    expect(JSON.stringify(redactPiPrototypeCredentialSetting(raw))).not.toContain(
      FIXTURE_CREDENTIAL,
    );

    await reloaded.remove("anthropic");
    expect(await reloaded.status("anthropic")).toEqual({
      provider: "anthropic",
      configured: false,
      updatedAt: undefined,
    });
    expect(await reloaded.status("openai")).toMatchObject({ configured: true });
  });

  it("ignores the host Pi profile and streams an exact qualified model through Rome", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "rome-pi-host-fixture-"));
    const normalPiHome = join(fixtureRoot, ".pi", "agent");
    const sentinel = join(fixtureRoot, "sentinel-command-ran");
    const extensionSentinel = join(fixtureRoot, "sentinel-extension-ran");
    await mkdir(join(normalPiHome, "extensions"), { recursive: true });
    await mkdir(join(normalPiHome, "prompts"), { recursive: true });
    await writeFile(
      join(normalPiHome, "auth.json"),
      '{"anthropic":{"type":"api_key","key":"host-value"}}',
    );
    await writeFile(
      join(normalPiHome, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: { apiKey: `!touch ${sentinel}`, modelOverrides: {} },
        },
      }),
    );
    await writeFile(
      join(normalPiHome, "extensions", "sentinel.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(extensionSentinel)}, "ran");`,
    );
    await writeFile(
      join(normalPiHome, "prompts", "sentinel.md"),
      "fixture prompt must stay unread",
    );
    await writeFile(
      join(normalPiHome, "settings.json"),
      JSON.stringify({ extensions: [join(normalPiHome, "extensions", "sentinel.mjs")] }),
    );

    process.env.HOME = fixtureRoot;
    process.env.PI_CODING_AGENT_DIR = normalPiHome;
    process.env.ANTHROPIC_API_KEY = "ambient-fixture-value";
    process.env.OPENAI_API_KEY = "unrelated-ambient-value";
    await credentials.save("anthropic", FIXTURE_CREDENTIAL);
    await credentials.save("openai", "unselected-rome-fixture-value");

    const models = await discoverPiModels(credentials, "anthropic");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.id.startsWith("anthropic/"))).toBe(true);
    const selected = models[0].id;

    const provider = new PiChildPrototypeProvider(credentials, { response: "fixture response" });
    const session = await provider.openSession(sessionParams(selected));
    const iterator = session.events[Symbol.asyncIterator]();
    await session.sendUserInput({ text: "fixture prompt" });
    const messages: AgentMessage[] = [];
    while (messages.length < 5) {
      const next = await iterator.next();
      if (next.done) break;
      messages.push(next.value);
      if (next.value.type === "result") break;
    }
    await session.close();

    expect(messages).toContainEqual({ type: "text_delta", content: "fixture response" });
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      content: "fixture response",
      accounting: { provider: "pi", model: selected },
    });
    expect(JSON.stringify({ models, messages })).not.toContain(FIXTURE_CREDENTIAL);
    await expect(access(sentinel)).rejects.toThrow();
    await expect(access(extensionSentinel)).rejects.toThrow();
    expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-fixture-value");
  }, 15_000);

  it("cancels the credential-bearing child and gives no credential to the next child", async () => {
    const controller = new AbortController();
    const operation = runIsolatedPiChild({
      provider: "anthropic",
      credential: FIXTURE_CREDENTIAL,
      signal: controller.signal,
      request: {
        operation: "run",
        model: "claude-haiku-4-5",
        fixture: { response: "unused", waitForCancellation: true },
      },
    });
    const iterator = operation[Symbol.asyncIterator]();
    const isolation = await iterator.next();
    expect(isolation.value).toEqual({
      type: "isolation",
      environmentNames: ["ANTHROPIC_API_KEY", "PI_OFFLINE", "ROME_PI_SELECTED_PROVIDER"],
      selectedCredentialPresent: true,
    });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow("cancelled");

    const later = await collect(
      runIsolatedPiChild({ provider: "anthropic", request: { operation: "probe" } }),
    );
    expect(later).toEqual([
      {
        type: "isolation",
        environmentNames: ["PI_OFFLINE", "ROME_PI_SELECTED_PROVIDER"],
        selectedCredentialPresent: false,
      },
    ]);
    expect(JSON.stringify(later)).not.toContain(FIXTURE_CREDENTIAL);
  }, 15_000);
});
