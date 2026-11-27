/**
 * An app built against @rome-os/app-runtime 0.11 still compiles against this
 * release and still runs: the fixture below names every symbol People's
 * removal deprecated, typed from the SDK as published here, and each port the
 * host restores answers without throwing. The web SDK's `people` page is
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
  deprecatedActionDeps,
  deprecatedGuardianProfile,
  deprecatedPolicyEngine,
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

describe("the app SDK surface People's removal deprecated", () => {
  it("compiles an app built against 0.11, and each restored port answers nobody", async () => {
    const repositories = {
      settings: { get: async () => null, set: async () => {} },
      guardianProfile: deprecatedGuardianProfile({
        db: testDb.db,
        settingsRepo: new SettingsRepository(testDb.db),
        reactivateFloating: async () => {},
      }),
    } satisfies AppRuntimeRepositories;
    const deps = { ...deprecatedActionDeps(), policyEngine } as unknown as AppDeps;

    expect(await appBuiltAgainst011(deps, repositories)).toEqual({
      person: null,
      sender: undefined,
      rule: { action: "allow" },
      stop: expect.anything(),
      receipt: "You can only stop a response that you started.",
      // A blank name with none stored writes nothing, as before.
      profile: { ok: false },
      guardian: { accounts: [] },
      stranger: "__STRANGER__",
      byName: [],
      fuzzy: null,
      byBond: [],
      byAccount: null,
      approvalType: true,
    });
  });

  it("refuses the writes 0.11 already refused, without crashing the caller", async () => {
    const repo = (deprecatedActionDeps() as unknown as AppDeps).personMappingRepo;
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
});
