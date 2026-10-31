import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type FullConfig, request } from "@playwright/test";
import { GUARDIAN, STORAGE_STATE, control } from "./control";

// Brings the instance to where a guardian left it after setup: an account,
// a signed-in session, and a model. The model is the launcher's fake
// Anthropic API, stored through the same route Settings' "Custom environment"
// form uses, so the real Claude provider and CLI answer every turn.
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]!.use.baseURL!;
  const api = await request.newContext({ baseURL });

  const bootstrap = (await (await api.get("/api/bootstrap")).json()) as { phase: string };
  if (bootstrap.phase === "needs-account") {
    const created = await api.post("/api/onboard/create-account", { data: GUARDIAN });
    if (!created.ok()) throw new Error(`Creating the guardian failed: ${created.status()}`);
  }
  const login = await api.post("/api/auth/login", { data: GUARDIAN });
  if (!login.ok()) throw new Error(`Guardian sign-in failed: ${login.status()}`);

  const { baseUrl } = await control.model();
  const saved = await api.put("/api/ai-tools/anthropic-compatible-credentials", {
    data: {
      provider: "custom",
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "e2e-not-a-real-token" },
    },
  });
  if (!saved.ok()) throw new Error(`Storing the model failed: ${saved.status()}`);
  const status = (await (await api.get("/api/ai-tools/status")).json()) as {
    claude?: { loggedIn?: boolean };
  };
  if (status.claude?.loggedIn !== true) throw new Error("Claude does not report as connected");

  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await api.storageState({ path: STORAGE_STATE });
  await api.dispose();
}
