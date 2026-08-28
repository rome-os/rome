// Every channel descriptor's profile projection (`reviveProfile`).
//
// Each channel owns a strict zod profile schema declared next to its material
// type and a pure display projection; the descriptor wires
// `reviveProfile = parse ∘ toDisplay`. These tests drive that wired getter
// through each descriptor surface (like oauth-providers.test.ts does for the
// Rome Cloud-OAuth providers) and pin three behaviors per channel:
//   - the display mapping (which parsed field lands on which display slot);
//   - a sparse-but-valid record stays sparse (never a thrown/defaulted display);
//   - a record that no longer matches the schema throws (fail-closed) rather than
//     rendering a silently sparse display.

import { describe, expect, it } from "@rstest/core";
import type { ConnectionDescriptor, ProfileRecord } from "../types.js";
import { makeDiscordDescriptor } from "./discord.js";
import { makeEmailDescriptor } from "./email.js";
import { createFeishuDescriptor } from "./feishu.js";
import { makeTelegramDescriptor } from "./telegram.js";
import { makeTelegramUserDescriptor } from "./telegram-user.js";
import { createWechatDescriptor } from "./wechat.js";

// Descriptor factories only STORE their deps (construction never calls them), so
// unit tests pass empty stubs to reach the pure `reviveProfile` getter.
const stub = {} as never;

interface ChannelCase {
  service: string;
  descriptor: ConnectionDescriptor;
  grant: string;
  full: ProfileRecord;
  expectedDisplay: {
    displayName: string | undefined;
    handle: string | undefined;
    email: string | undefined;
    avatarUrl: string | undefined;
  };
  /** A sparse-but-valid record and the single field it should surface. */
  sparse: { record: ProfileRecord; expect: Partial<ChannelCase["expectedDisplay"]> };
}

const CASES: ChannelCase[] = [
  {
    service: "telegram",
    descriptor: makeTelegramDescriptor(),
    grant: "bot",
    full: { botId: "42", botUsername: "@rome_bot" },
    expectedDisplay: {
      displayName: undefined,
      handle: "@rome_bot",
      email: undefined,
      avatarUrl: undefined,
    },
    sparse: { record: { botId: "42" }, expect: { handle: undefined } },
  },
  {
    service: "discord",
    descriptor: makeDiscordDescriptor({
      conversationSettings: stub,
      personMappingRepo: stub,
      listAgents: () => [],
    }),
    grant: "bot",
    full: { botId: "999", botUsername: "rome" },
    expectedDisplay: {
      displayName: undefined,
      handle: "rome",
      email: undefined,
      avatarUrl: undefined,
    },
    sparse: { record: { botId: "999" }, expect: { handle: undefined } },
  },
  {
    service: "feishu",
    descriptor: createFeishuDescriptor({
      conversationSettings: stub,
      personMappingRepo: stub,
      listAgents: () => [],
    }),
    grant: "app",
    full: { appId: "cli_abc", domain: "lark", appType: "manual" },
    expectedDisplay: {
      displayName: undefined,
      handle: "cli_abc",
      email: undefined,
      avatarUrl: undefined,
    },
    sparse: { record: { domain: "feishu" }, expect: { handle: undefined } },
  },
  {
    service: "wechat",
    descriptor: createWechatDescriptor(),
    grant: "account",
    full: { accountId: "acct-1", userId: "guardian-7" },
    expectedDisplay: {
      displayName: undefined,
      handle: "acct-1",
      email: undefined,
      avatarUrl: undefined,
    },
    sparse: { record: { userId: "guardian-7" }, expect: { handle: undefined } },
  },
  {
    service: "email",
    descriptor: makeEmailDescriptor({
      provider: stub,
      settingsRepo: stub,
      personMappingRepo: stub,
    }),
    grant: "inbox",
    full: { address: "slug@romeos.cc" },
    expectedDisplay: {
      displayName: undefined,
      handle: "slug@romeos.cc",
      email: "slug@romeos.cc",
      avatarUrl: undefined,
    },
    sparse: { record: {}, expect: { email: undefined, handle: undefined } },
  },
  {
    service: "telegram_user",
    descriptor: makeTelegramUserDescriptor(),
    grant: "session",
    full: {
      userId: "42",
      username: "@guardian",
      displayName: "Guardian",
      phoneNumber: "+15551234567",
      connectedAt: "2026-01-01T00:00:00.000Z",
    },
    expectedDisplay: {
      displayName: "Guardian",
      handle: "@guardian",
      email: undefined,
      avatarUrl: undefined,
    },
    sparse: { record: { userId: "42" }, expect: { displayName: undefined, handle: undefined } },
  },
];

describe.each(CASES)("$service descriptor reviveProfile", (c) => {
  it("wires reviveProfile and projects the stored record onto the display slots", () => {
    expect(c.descriptor.reviveProfile).toBeDefined();
    const display = c.descriptor.reviveProfile?.(c.grant, c.full);
    expect(display).toMatchObject(c.expectedDisplay);
    // Service-specific keys (botId, domain, teamId-style ids) never widen the
    // display surface — only the four ProfileDisplay slots exist.
    expect(display && Object.keys(display).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "email",
      "handle",
    ]);
  });

  it("keeps a sparse-but-valid record sparse (no thrown or defaulted display)", () => {
    const display = c.descriptor.reviveProfile?.(c.grant, c.sparse.record);
    expect(display).toMatchObject(c.sparse.expect);
    // An empty record is still valid and fully sparse.
    const empty = c.descriptor.reviveProfile?.(c.grant, {});
    expect(empty?.displayName).toBeUndefined();
    expect(empty?.handle).toBeUndefined();
    expect(empty?.email).toBeUndefined();
    expect(empty?.avatarUrl).toBeUndefined();
  });

  it("rejects a record that no longer matches the schema — never a silently sparse display", () => {
    // A wrong-typed value on a known field (every full record's first key is a
    // schema string field).
    const [firstKey] = Object.keys(c.full);
    expect(() => c.descriptor.reviveProfile?.(c.grant, { ...c.full, [firstKey]: 42 })).toThrow();
    // A key outside the service's schema (strict) fails loudly.
    expect(() =>
      c.descriptor.reviveProfile?.(c.grant, { ...c.full, unexpectedKey: "x" }),
    ).toThrow();
  });
});
