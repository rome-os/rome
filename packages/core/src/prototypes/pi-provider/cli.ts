import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { getDb } from "../../db/index.js";
import { SettingsRepository } from "../../db/repositories/settings.js";
import type { AgentMessage } from "../../types.js";
import type { ModelSessionParams } from "../../core/agent-runner.js";
import {
  isReviewedPiProviderId,
  type PiReviewedProviderId,
} from "../../core/pi-provider-boundary.js";
import {
  discoverPiModels,
  PiChildPrototypeProvider,
  PiPrototypeCredentialStore,
} from "./pi-child-prototype.js";

const [command, providerArg, ...rest] = process.argv.slice(2);
if (!isReviewedPiProviderId(providerArg ?? "")) throw new Error("Choose a reviewed provider ID.");
const provider = providerArg as PiReviewedProviderId;
const credentials = new PiPrototypeCredentialStore(new SettingsRepository(getDb()));

async function readToken(): Promise<string> {
  const reader = createInterface({ input: stdin, terminal: false });
  let value = "";
  for await (const line of reader) value += line;
  return value;
}

if (command === "save") {
  stdout.write(`${JSON.stringify(await credentials.save(provider, await readToken()))}\n`);
} else if (command === "status") {
  stdout.write(`${JSON.stringify(await credentials.status(provider))}\n`);
} else if (command === "remove") {
  stdout.write(`${JSON.stringify(await credentials.remove(provider))}\n`);
} else if (command === "discover") {
  stdout.write(`${JSON.stringify(await discoverPiModels(credentials, provider), null, 2)}\n`);
} else if (command === "run") {
  const [qualifiedModel, ...promptParts] = rest;
  if (!qualifiedModel || promptParts.length === 0)
    throw new Error("Pass a qualified model and prompt.");
  const modelProvider = new PiChildPrototypeProvider(credentials);
  const params: ModelSessionParams = {
    model: qualifiedModel,
    systemPrompt: "You are a helpful assistant running through Rome's Pi isolation prototype.",
    sessionId: `pi-prototype-${Date.now()}`,
    getActionCatalog: () => [],
    getSkillCatalog: () => [],
    subagentTools: [],
    executeAction: async () => undefined,
    executeSubagent: async () => undefined,
  };
  const session = await modelProvider.openSession(params);
  await session.sendUserInput({ text: promptParts.join(" ") });
  for await (const message of session.events) {
    stdout.write(`${JSON.stringify(message satisfies AgentMessage)}\n`);
    if (message.type === "result" || message.type === "error") break;
  }
  await session.close();
} else {
  throw new Error("Use save, status, remove, discover, or run.");
}
