import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPiModelRuntime,
  discoverPiModels,
  inspectPiSessionIsolation,
  runPiPrototypeTurn,
} from "./pi-sdk-prototype.js";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm --filter @rome/core prototype:pi demo",
      "  pnpm --filter @rome/core prototype:pi discover [--refresh]",
      '  pnpm --filter @rome/core prototype:pi run <qualified-model-id> "<prompt>"',
    ].join("\n"),
  );
}

async function demo(): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "rome-pi-provider-prototype-"));
  try {
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "prototype-a": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "local-demo-placeholder",
            models: [{ id: "shared/model", name: "Shared model via A" }],
          },
          "prototype-b": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "local-demo-placeholder",
            models: [{ id: "shared/model", name: "Shared model via B" }],
          },
        },
      }),
    );
    const runtime = await createPiModelRuntime({ agentDir });
    const discovery = await discoverPiModels(runtime);
    const demoModel = discovery.models[0];
    if (!demoModel) {
      throw new Error(
        "Pi prototype demo discovered no models; check the embedded models.json fixture and Pi SDK compatibility.",
      );
    }
    const sessionIsolation = await inspectPiSessionIsolation({
      runtime,
      qualifiedModelId: demoModel.qualifiedModelId,
    });
    console.log(JSON.stringify({ ...discovery, sessionIsolation }, null, 2));
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "--") rawArgs.shift();
  const [command = "demo", ...args] = rawArgs;
  if (command === "demo") {
    if (args.length) usage();
    await demo();
    return;
  }

  if (command === "discover") {
    if (args.some((arg) => arg !== "--refresh")) usage();
    const runtime = await createPiModelRuntime();
    console.log(
      JSON.stringify(
        await discoverPiModels(runtime, { refreshNetwork: args.includes("--refresh") }),
        null,
        2,
      ),
    );
    return;
  }

  if (command === "run") {
    const [qualifiedModelId, ...promptParts] = args;
    if (!qualifiedModelId || !promptParts.length) usage();
    const runtime = await createPiModelRuntime();
    await runPiPrototypeTurn({
      runtime,
      qualifiedModelId,
      prompt: promptParts.join(" "),
      emit(message) {
        console.log(JSON.stringify(message));
      },
    });
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
