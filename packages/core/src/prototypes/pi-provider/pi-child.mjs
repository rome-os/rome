import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = process.argv[2];
const provider = process.env.ROME_PI_SELECTED_PROVIDER;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeUsage(usage) {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cost: usage?.cost?.total ?? 0,
  };
}

let stage = "input";
try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  stage = "configuration";
  if (!root || !provider) throw new Error("missing isolated child configuration");

  send({
    type: "isolation",
    environmentNames: Object.keys(process.env).sort(),
    selectedCredentialPresent: process.env.ANTHROPIC_API_KEY !== undefined,
  });

  if (request.operation === "probe") process.exit(0);

  stage = "runtime";
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  stage = "availability";
  const models = await runtime.getAvailable(provider);

  if (request.operation === "discover") {
    send({
      type: "models",
      models: models.map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
    });
    process.exit(0);
  }

  const model = models.find((candidate) => candidate.id === request.model);
  if (!model) throw new Error("selected model is unavailable");

  if (request.fixture) {
    if (request.fixture.waitForCancellation) await new Promise(() => {});
    send({ type: "text_delta", content: request.fixture.response });
    send({
      type: "done",
      content: request.fixture.response,
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0 },
      stopReason: "stop",
    });
    process.exit(0);
  }

  const stream = runtime.streamSimple(
    model,
    {
      systemPrompt: request.systemPrompt,
      messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
    },
    { signal: AbortSignal.timeout(request.timeoutMs ?? 120_000) },
  );

  for await (const event of stream) {
    if (event.type === "text_delta") send({ type: "text_delta", content: event.delta });
    if (event.type === "done") {
      const content = event.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      send({
        type: "done",
        content,
        usage: safeUsage(event.message.usage),
        stopReason: event.message.stopReason,
      });
    }
    if (event.type === "error") throw new Error("provider request failed");
  }
} catch {
  send({
    type: "error",
    code: "pi_child_failed",
    stage,
    message: "The isolated Pi operation failed.",
  });
  process.exitCode = 1;
}
