/**
 * An app built against @rome-os/app-runtime 0.11 still compiles against this
 * release and still runs: the fixture below names every symbol People's
 * removal deprecated, typed from the SDK as published here, and each port the
 * host restores answers without throwing. Each use is reported once an hour
 * per app and symbol, with the symbol and the app id alone. The web SDK's `people` page is
 * pinned in its own tests.
 */
import { afterAll, describe, expect, it } from "@rstest/core";
import {
  APPROVAL_TYPES,
  chatStopReceipt,
  type AppRuntimeRepositories,
  type BondLevel,
  type ChannelMappingRecord,
  type ChatId,
  type ChatStopInput,
  type ChatStopStatus,
  type GuardianProfileRepository,
  type GuardianProfileWrite,
  type PeopleService,
  type PersonMappingRepository,
  type PersonRecord,
  type PolicyContext,
  type PolicyEngine,
  type PolicyRule,
  type SaidInboundEvent,
  type SaidSender,
  type ThreadContext,
} from "@rome-os/app-runtime";
import { SettingsRepository } from "../db/repositories/settings.js";
import { createTestDb } from "../test/db.js";
import type { Policy } from "../types.js";
import {
  DEPRECATED_USE_MESSAGE,
  deprecatedChatStopFor,
  deprecatedGuardianProfile,
  deprecatedPolicyEngine,
  deprecatedRepositoriesFor,
  deprecatedUseReporter,
  withDeprecatedActionDeps,
} from "./deprecated-app-ports.js";

/** What a 0.11 app's action reads from its deps. */
interface AppDeps {
  people: PeopleService;
  personMappingRepo: PersonMappingRepository;
  policyEngine: PolicyEngine;
  strangerPersonId: string;
}

/** Code an app wrote against 0.11, each deprecated symbol once. */
async function appBuiltAgainst011(deps: AppDeps, repositories: AppRuntimeRepositories) {
  const bond: BondLevel = "inner-circle";
  const mapping: ChannelMappingRecord = { channel: "telegram", channelUserId: "42" };
  const person: PersonRecord | null = await deps.personMappingRepo.findByChannelUser(
    mapping.channel,
    mapping.channelUserId,
  );
  const sender: SaidSender | undefined = ({} as SaidInboundEvent).sender;
  const context: ThreadContext = { channel: "telegram", threadId: "1", senderBondLevel: bond };
  const policyContext: PolicyContext = { channel: context.channel, sender: null, bondLevel: bond };
  const rule: PolicyRule = await deps.policyEngine.evaluate(policyContext);
  const stop: ChatStopInput = {
    ref: { connectionId: "c1", chatId: "1" as ChatId },
    service: "telegram",
    senderId: "42",
  };
  const forbidden: ChatStopStatus = "forbidden";
  const write: GuardianProfileWrite = { guardianName: "" };
  const profile: GuardianProfileRepository | undefined = repositories.guardianProfile;
  return {
    person,
    sender,
    rule,
    stop,
    receipt: chatStopReceipt(forbidden),
    profile: await profile?.write(write),
    guardian: await deps.people.guardian(),
    stranger: deps.strangerPersonId,
    byName: await deps.personMappingRepo.findByName("Ana"),
    fuzzy: await deps.personMappingRepo.findByNameFuzzy("ana"),
    byBond: await deps.personMappingRepo.findByBondLevel(bond),
    byAccount: await deps.personMappingRepo.findByAccount?.({ platform: "telegram", id: "42" }),
    approvalType: APPROVAL_TYPES.includes("person_mapping"),
  };
}

const testDb = createTestDb();
afterAll(() => testDb.close());

const policies: Policy[] = [];
const policyEngine = deprecatedPolicyEngine({
  policies: async () => policies,
  connectionKindOf: (name) => name,
});

/** A report that records each use. */
function recordedUses() {
  const uses: Array<[string, string]> = [];
  return { uses, report: (appId: string, symbol: string) => void uses.push([appId, symbol]) };
}

function depsOf(appId: string, report: (appId: string, symbol: string) => void): AppDeps {
  const access = { guardianAccounts: async () => [{ platform: "telegram", id: "guardian-1" }] };
  return withDeprecatedActionDeps(
    appId,
    { policyEngine, appContext: { access } },
    report,
  ) as unknown as AppDeps;
}

describe("the app SDK surface People's removal deprecated", () => {
  it("compiles an app built against 0.11, and each restored port answers as before", async () => {
    const { uses, report } = recordedUses();
    const repositories = deprecatedRepositoriesFor(
      {
        settings: { get: async () => null, set: async () => {} },
        guardianProfile: deprecatedGuardianProfile({
          db: testDb.db,
          settingsRepo: new SettingsRepository(testDb.db),
          reactivateFloating: async () => {},
        }),
      },
      "old-app",
      report,
    );

    expect(await appBuiltAgainst011(depsOf("old-app", report), repositories)).toEqual({
      person: null,
      sender: undefined,
      rule: { action: "allow" },
      stop: expect.anything(),
      receipt: "You can only stop a response that you started.",
      // A blank name with none stored writes nothing, as before.
      profile: { ok: false },
      // As the app's `ctx.access` answers them.
      guardian: { accounts: [{ platform: "telegram", id: "guardian-1" }] },
      stranger: "__STRANGER__",
      byName: [],
      fuzzy: null,
      byBond: [],
      byAccount: null,
      approvalType: true,
    });
    expect(uses.map(([, symbol]) => symbol).sort()).toEqual([
      "people.guardian",
      "personMappingRepo.findByAccount",
      "personMappingRepo.findByBondLevel",
      "personMappingRepo.findByChannelUser",
      "personMappingRepo.findByName",
      "personMappingRepo.findByNameFuzzy",
      "policyEngine.evaluate",
      "repositories.guardianProfile.write",
      "strangerPersonId",
    ]);
    expect(new Set(uses.map(([appId]) => appId))).toEqual(new Set(["old-app"]));
  });

  it("refuses the writes 0.11 already refused, without crashing the caller", async () => {
    const repo = depsOf("old-app", () => {}).personMappingRepo;
    await expect(repo.create({ displayName: "Ana", bondLevel: "other" })).rejects.toThrow(
      "Apps cannot add persons",
    );
    await expect(repo.addChannelMapping("p1", "telegram", "42")).rejects.toThrow(
      "Apps cannot link accounts",
    );
  });

  it("still answers the guardian's channel policy", async () => {
    policies.push({
      id: "p1",
      scope: { type: "channel", channel: "telegram" },
      rules: [{ action: "block" }],
      priority: 0,
    });
    expect(
      await policyEngine.evaluate({ channel: "telegram", sender: null, bondLevel: "other" }),
    ).toEqual({ action: "block" });
    policies.length = 0;
  });

  it("reports the deprecated values an app passes, and nothing for what it passes otherwise", async () => {
    const { uses, report } = recordedUses();
    const created: unknown[] = [];
    const ran: unknown[] = [];
    const deps = withDeprecatedActionDeps(
      "old-app",
      {
        approvalsRepo: { create: async (data: unknown) => void created.push(data) },
        agentRunner: { run: async (params: unknown) => void ran.push(params) },
      },
      report,
    );
    await deps.approvalsRepo.create({ type: "person_mapping" });
    await deps.approvalsRepo.create({ type: "action_execution" });
    await deps.agentRunner.run({ threadContext: { channel: "x", senderBondLevel: "guardian" } });
    await deps.agentRunner.run({ threadContext: { channel: "x" } });
    const stop = deprecatedChatStopFor(async () => ({ status: "idle" }), "old-app", report);
    await stop({
      ref: { connectionId: "c1", chatId: "1" as ChatId },
      service: "t",
      senderId: "42",
    });
    await stop({ ref: { connectionId: "c1", chatId: "1" as ChatId } });

    expect(created).toHaveLength(2);
    expect(ran).toHaveLength(2);
    expect(uses).toEqual([
      ["old-app", "APPROVAL_TYPES.person_mapping"],
      ["old-app", "ThreadContext.senderBondLevel"],
      ["old-app", "ChatStopInput.service"],
      ["old-app", "ChatStopInput.senderId"],
    ]);
  });
});

describe("deprecatedUseReporter", () => {
  it("writes one record per app and symbol an hour, holding the symbol and nothing else", async () => {
    const records: Array<{ appId: string; message: string; data: unknown }> = [];
    let now = 0;
    const report = deprecatedUseReporter({
      log: (appId) => ({
        info: (message: string, data?: unknown) => void records.push({ appId, message, data }),
      }),
      now: () => now,
    });
    const deps = depsOf("old-app", report);

    await deps.personMappingRepo.findByChannelUser("telegram", "secret-sender-id");
    await deps.personMappingRepo.findByChannelUser("telegram", "another-sender");
    now += 59 * 60 * 1000;
    await deps.personMappingRepo.findByChannelUser("telegram", "x");
    await depsOf("other-app", report).personMappingRepo.findByChannelUser("telegram", "x");
    now += 60 * 1000;
    await deps.personMappingRepo.findByChannelUser("telegram", "x");

    expect(records).toEqual([
      {
        appId: "old-app",
        message: DEPRECATED_USE_MESSAGE,
        data: { "rome.sdk.symbol": "personMappingRepo.findByChannelUser" },
      },
      {
        appId: "other-app",
        message: DEPRECATED_USE_MESSAGE,
        data: { "rome.sdk.symbol": "personMappingRepo.findByChannelUser" },
      },
      {
        appId: "old-app",
        message: DEPRECATED_USE_MESSAGE,
        data: { "rome.sdk.symbol": "personMappingRepo.findByChannelUser" },
      },
    ]);
  });
});
