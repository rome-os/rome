import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "@rstest/core";
import { checkImports, formatImportViolation } from "./import-rules.js";
import { contextEntryRules, contextRules } from "./rules/contexts.js";
import { featureRules } from "./rules/features.js";
import { kindRulesFor } from "./rules/kinds.js";
import { layerRules } from "./rules/layers.js";
import { libraryRules } from "./rules/library.js";

const root = mkdtempSync(join(tmpdir(), "import-rules-"));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

write("package.json", JSON.stringify({ type: "module" }));
write(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      paths: { "@/*": ["./src/*"] },
    },
  }),
);
write("src/logger.ts", "export const log = 1;\n");
write("src/agent/index.ts", 'export * from "./domain/session.js";\n');
write("src/agent/domain/session.ts", "export type Session = { id: string };\n");
write("src/agent/application/use.ts", "export const use = 1;\n");
write("src/agent/infrastructure/model/adapter.ts", "export const adapter = 1;\n");
write(
  "src/agent/domain/probe.ts",
  [
    'import "./session.js";',
    'import "zod";',
    'import "../index.js";',
    'import "@/logger.js";',
    'type T = import("../../logger.js").X;',
    'import "./x/../../infrastructure/model/adapter.js";',
    "const name = 'x'; void import(name);",
  ].join("\n"),
);
write(
  "src/agent/application/sub/probe.ts",
  [
    'import "../../domain/session.js";',
    'import "../use.js";',
    'import "../../infrastructure/model/adapter.js";',
  ].join("\n"),
);
write(
  "src/agent/infrastructure/model/probe.ts",
  [
    'import "../../domain/session.js";',
    'import "@/logger.js";',
    'import "../../index.js";',
    'import "../../../agent/./application/use.js";',
  ].join("\n"),
);
write(
  "src/concierge/probe.ts",
  [
    'import "../agent/index.js";',
    'import "../agent/./domain/session.js";',
    'export * from "@/agent//infrastructure/model/adapter.js";',
    'import "../agent/domain/nope.js";',
  ].join("\n"),
);

write("src/apps/catalog.ts", "export type AppCatalog = { size: number };\n");
write(
  "src/agent/infrastructure/apps-probe.ts",
  ['import type { AppCatalog } from "../../apps/catalog.js";', 'import "@/apps/catalog.js";'].join(
    "\n",
  ),
);
write("src/routines/agent-probe.ts", 'import "../agent/index.js";\n');
write("src/lib/clock.ts", "export const now = 1;\n");
write(
  "src/lib/probe.test.ts",
  [
    'import type { AppCatalog } from "../apps/catalog.js";',
    'import "@/agent/index.js";',
    'import "./clock.js";',
    'import "../logger.js";',
  ].join("\n"),
);

write("src/people/read.ts", 'import "./phone-book/index.js";\n');
write("src/people/model/person.ts", "export type Person = { id: string };\n");
write("src/people/infrastructure/repo.ts", 'import "drizzle-orm";\nimport "../model/person.js";\n');
write("src/people/phone-book/index.ts", 'export * from "./edit.js";\n');
write(
  "src/people/phone-book/edit.ts",
  ['import "../read.js";', 'import "../person-history/index.js";', 'import "drizzle-orm";'].join(
    "\n",
  ),
);
write("src/people/phone-book/edit.test.ts", 'import "drizzle-orm";\n');
write("src/people/phone-book/list.ts", 'import "hono";\n');
write("src/people/phone-book/http/people.ts", 'import "hono";\nimport "../list.js";\n');
write(
  "src/people/phone-book/application/edit.ts",
  'import "../http/people.js";\nimport "../../model/person.js";\n',
);
write(
  "src/people/phone-book/actions/list.ts",
  'import "../http/people.js";\nimport "../application/edit.js";\n',
);
write("src/people/person-history/index.ts", "export const history = 1;\n");
write("src/people/link-code/index.ts", "export const code = 1;\n");
write(
  "src/chats/people-probe.ts",
  [
    'import "../people/read.js";',
    'import "../people/phone-book/index.js";',
    'import "../people/phone-book/edit.js";',
  ].join("\n"),
);
write("src/chats/people-probe.test.ts", 'import "../people/phone-book/index.js";\n');
write("src/api/routes/people/phone-book.ts", 'import "../../../people/phone-book/index.js";\n');
write("src/index.ts", 'import "./people/phone-book/index.js";\n');
write("src/connections/kinds/discord/discord.ts", 'import "../../../people/link-code/index.js";\n');

write("src/connections/registry.ts", 'import "./kinds/slack/index.js";\n');
write("src/connections/registry.test.ts", 'import "./kinds/slack/slack.js";\n');
write("src/connections/kinds/slack/index.ts", 'export * from "./slack.js";\n');
write(
  "src/connections/kinds/slack/slack.ts",
  ['import "../../registry.js";', 'import "../discord/discord.js";', 'import "hono";'].join("\n"),
);
write(
  "src/connections/kinds/slack/http/routes.ts",
  'import "hono";\nimport "../actions/post.js";\n',
);
write("src/connections/kinds/slack/actions/post.ts", "export const post = 1;\n");
write("src/connections/kinds/slack/application/send.ts", 'import "../http/routes.js";\n');
write("src/connections/kinds/slack/infrastructure/store.ts", 'import "drizzle-orm";\n');
write("src/connections/kinds/slack/store.ts", 'import "drizzle-orm";\n');
write(
  "src/chats/slack-probe.ts",
  'import "../connections/kinds/slack/index.js";\nimport "../connections/kinds/slack/slack.js";\n',
);
write("src/test/kit/slack.ts", 'import "../../connections/kinds/slack/slack.js";\n');
write("src/chats/slack-probe.test.ts", 'import "../connections/kinds/slack/slack.js";\n');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("checkImports with the layer rules", () => {
  it("judges each import by the file it resolves to", () => {
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), layerRules)
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter((line) => line.startsWith("agent/") || line.startsWith("concierge/"));
    expect(lines).toEqual([
      "agent/application/sub/probe.ts:3 → ../../infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) [application-imports-inward]",
      "agent/domain/probe.ts:3 → ../index.js (agent/index.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:4 → @/logger.js (logger.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:5 → ../../logger.js (logger.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:6 → ./x/../../infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) [domain-imports-domain]",
      "agent/domain/probe.ts:7 → <computed> [literal-imports-in-contexts]",
      "agent/infrastructure/model/probe.ts:3 → ../../index.js (agent/index.ts) [infrastructure-imports-inward]",
      "agent/infrastructure/model/probe.ts:4 → ../../../agent/./application/use.js (agent/application/use.ts) [infrastructure-imports-inward]",
      "concierge/probe.ts:2 → ../agent/./domain/session.js (agent/domain/session.ts) [enter-through-index]",
      "concierge/probe.ts:3 → @/agent//infrastructure/model/adapter.js (agent/infrastructure/model/adapter.ts) [enter-through-index]",
      "concierge/probe.ts:4 → ../agent/domain/nope.js [unresolved]",
    ]);
  });

  it("skips a listed crossing and reports a listed crossing that no longer occurs", () => {
    const crossing = (from: string, to: string) => ({
      rule: "application-imports-inward",
      from,
      to,
      ticket: "ZHA-0",
      why: "fixture",
    });
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), layerRules, [
      crossing("agent/application/sub/probe.ts", "agent/infrastructure/model/adapter.ts"),
      crossing("agent/application/use.ts", "logger.ts"),
    ])
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter((line) => line.startsWith("agent/application/"));
    expect(lines).toEqual(["agent/application/use.ts → logger.ts [stale-listing]"]);
  });
});

describe("checkImports with the context rules", () => {
  it("rejects every import from agent/ into apps/, type-only included, and allows one a context may make", () => {
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), contextRules)
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter((line) => !line.includes("[unresolved]"));
    expect(lines).toEqual([
      "agent/infrastructure/apps-probe.ts:1 → ../../apps/catalog.js (apps/catalog.ts) [agent-never-imports-apps]",
      "agent/infrastructure/apps-probe.ts:2 → @/apps/catalog.js (apps/catalog.ts) [agent-never-imports-apps]",
      "connections/kinds/discord/discord.ts:1 → ../../../people/link-code/index.js (people/link-code/index.ts) [connections-never-imports-people]",
    ]);
  });
});

describe("checkImports with the rules around a connection's message", () => {
  const at = mkdtempSync(join(tmpdir(), "import-rules-message-"));
  afterAll(() => rmSync(at, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(at, path)), { recursive: true });
    writeFileSync(join(at, path), text);
  };
  put("package.json", JSON.stringify({ type: "module" }));
  put(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
  );
  put("src/chats/connected-accounts/channel-message.ts", "export const of = 1;\n");
  put("src/chats/connected-accounts/connection-ports.ts", 'import "./channel-message.js";\n');
  put("src/chats/history/reader.ts", 'import "../connected-accounts/channel-message.js";\n');
  put("src/participation/addressing.ts", "export const addressing = 1;\n");
  put("src/people/person.ts", "export const person = 1;\n");
  put(
    "src/connections/kinds/x/x.ts",
    [
      'import "../../../participation/addressing.js";',
      'import "../../../people/person.js";',
      'import "../../../chats/connected-accounts/channel-message.js";',
      "",
    ].join("\n"),
  );
  put(
    "src/connections/kinds/x/x.test.ts",
    'import "../../../chats/connected-accounts/channel-message.js";\n',
  );
  put("src/test/kit.ts", 'import "../chats/connected-accounts/channel-message.js";\n');

  const lines = checkImports(join(at, "src"), join(at, "tsconfig.json"), [
    ...contextRules,
    ...contextEntryRules,
  ])
    .map(formatImportViolation)
    .map((line) => line.replace(/ \(.*\)/, "").replace(/: .*$/, ""));

  it("rejects a connection that imports Participation, People or Chats, and lets its tests reach Chats", () => {
    expect(lines.filter((line) => line.startsWith("connections/"))).toEqual([
      "connections/kinds/x/x.ts:1 → ../../../participation/addressing.js [connections-never-imports-participation]",
      "connections/kinds/x/x.ts:2 → ../../../people/person.js [connections-never-imports-people]",
      "connections/kinds/x/x.ts:3 → ../../../chats/connected-accounts/channel-message.js [connections-never-imports-chats]",
      "connections/kinds/x/x.ts:3 → ../../../chats/connected-accounts/channel-message.js [channel-message-built-in-one-place]",
    ]);
  });

  it("builds what an app receives only in connection-ports.ts, tests and the test kit", () => {
    expect(lines.filter((line) => line.includes("[channel-message-built-in-one-place]"))).toEqual([
      "chats/history/reader.ts:1 → ../connected-accounts/channel-message.js [channel-message-built-in-one-place]",
      "connections/kinds/x/x.ts:3 → ../../../chats/connected-accounts/channel-message.js [channel-message-built-in-one-place]",
    ]);
  });
});

describe("checkImports with the chat rule declarations", () => {
  const at = mkdtempSync(join(tmpdir(), "import-rules-chat-rules-"));
  afterAll(() => rmSync(at, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(at, path)), { recursive: true });
    writeFileSync(join(at, path), text);
  };
  put("package.json", JSON.stringify({ type: "module" }));
  put(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
  );
  put("src/chat-settings/rules.ts", "export const rules = 1;\n");
  put("src/chat-settings/service.ts", "export const service = 1;\n");
  put("src/chat-settings/repository.ts", "export const repository = 1;\n");
  put(
    "src/connections/kinds/x/x.ts",
    [
      'import "../../../chat-settings/rules.js";',
      'import "../../../chat-settings/service.js";',
      'import "../../../chat-settings/repository.js";',
      "",
    ].join("\n"),
  );
  put("src/connections/kinds/x/x.test.ts", 'import "../../../chat-settings/service.js";\n');

  it("lets a kind import only the rules it declares, and its tests reach the service", () => {
    const lines = checkImports(join(at, "src"), join(at, "tsconfig.json"), contextEntryRules)
      .map(formatImportViolation)
      .map((line) => line.replace(/ \(.*\)/, "").replace(/: .*$/, ""));
    expect(lines).toEqual([
      "connections/kinds/x/x.ts:2 → ../../../chat-settings/service.js [connections-declare-chat-rules-only]",
      "connections/kinds/x/x.ts:3 → ../../../chat-settings/repository.js [connections-declare-chat-rules-only]",
    ]);
  });
});

describe("checkImports with the library rule", () => {
  it("rejects every import from lib/ into a context, type-only and tests included, and allows the rest", () => {
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), libraryRules)
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter((line) => !line.includes("[unresolved]"));
    expect(lines).toEqual([
      "lib/probe.test.ts:1 → ../apps/catalog.js (apps/catalog.ts) [lib-imports-no-context]",
      "lib/probe.test.ts:2 → @/agent/index.js (agent/index.ts) [lib-imports-no-context]",
    ]);
  });
});

describe("checkImports with the feature rules", () => {
  it("keeps features apart and off the root, and lets only the wiring, tests and listed files use them", () => {
    const lines = checkImports(join(root, "src"), join(root, "tsconfig.json"), [
      ...featureRules,
      ...layerRules,
    ])
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter(
        (line) =>
          line.startsWith("people/") ||
          line.startsWith("chats/") ||
          line.startsWith("api/") ||
          line.startsWith("connections/") ||
          line.startsWith("index.ts"),
      );
    expect(lines).toEqual([
      "api/routes/people/phone-book.ts:1 → ../../../people/phone-book/index.js (people/phone-book/index.ts) [features-used-from-wiring]",
      "chats/people-probe.ts:2 → ../people/phone-book/index.js (people/phone-book/index.ts) [features-used-from-wiring]",
      "chats/people-probe.ts:3 → ../people/phone-book/edit.js (people/phone-book/edit.ts) [features-used-from-wiring]",
      "chats/people-probe.ts:3 → ../people/phone-book/edit.js (people/phone-book/edit.ts) [enter-through-index]",
      "people/phone-book/actions/list.ts:1 → ../http/people.js (people/phone-book/http/people.ts) [adapters-import-inward]",
      "people/phone-book/application/edit.ts:1 → ../http/people.js (people/phone-book/http/people.ts) [adapters-import-inward]",
      "people/phone-book/application/edit.ts:1 → ../http/people.js (people/phone-book/http/people.ts) [application-imports-inward]",
      "people/phone-book/edit.ts:2 → ../person-history/index.js (people/person-history/index.ts) [features-import-no-sibling]",
      "people/phone-book/edit.ts:3 → drizzle-orm [drizzle-stays-in-infrastructure]",
      "people/phone-book/list.ts:1 → hono [hono-stays-in-http]",
      "people/read.ts:1 → ./phone-book/index.js (people/phone-book/index.ts) [domain-root-imports-no-feature]",
    ]);
  });
});

describe("checkImports with the kind rules", () => {
  it("keeps kinds apart and off the Connections root, and lets outside code in only through index.ts", () => {
    const lines = checkImports(
      join(root, "src"),
      join(root, "tsconfig.json"),
      kindRulesFor(["discord", "slack"]),
    )
      .map(formatImportViolation)
      .map((line) => line.replace(/: .*$/, ""))
      .filter((line) => !line.endsWith("[unresolved]"));
    expect(lines).toEqual([
      "chats/slack-probe.ts:2 → ../connections/kinds/slack/slack.js (connections/kinds/slack/slack.ts) [kinds-enter-through-index]",
      "connections/kinds/slack/application/send.ts:1 → ../http/routes.js (connections/kinds/slack/http/routes.ts) [kind-adapters-import-inward]",
      "connections/kinds/slack/http/routes.ts:2 → ../actions/post.js (connections/kinds/slack/actions/post.ts) [kind-adapters-import-inward]",
      "connections/kinds/slack/slack.ts:2 → ../discord/discord.js (connections/kinds/discord/discord.ts) [kinds-import-no-sibling]",
      "connections/kinds/slack/slack.ts:2 → ../discord/discord.js (connections/kinds/discord/discord.ts) [kinds-enter-through-index]",
      "connections/kinds/slack/slack.ts:3 → hono [kind-hono-stays-in-http]",
      "connections/kinds/slack/store.ts:1 → drizzle-orm [kind-drizzle-stays-in-infrastructure]",
      "connections/registry.ts:1 → ./kinds/slack/index.js (connections/kinds/slack/index.ts) [connections-root-names-no-kind]",
    ]);
  });
});
