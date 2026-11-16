import {
  VAULT_MAX_DESCRIPTION_LENGTH,
  VAULT_MAX_VALUE_LENGTH,
  type VaultSecretDto,
  vaultNameError,
} from "@rome/api-types/vault";
import { http, HttpResponse } from "msw";

// Vault fixtures. Name validation is imported, not restated, so the mock
// rejects exactly the names core rejects. Values are never stored: the mock
// keeps metadata only, like the real list.
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const store = new Map<string, Omit<VaultSecretDto, "name">>([
  [
    "GITHUB_TOKEN",
    {
      description: "GitHub token for releases",
      createdAt: hoursAgo(72),
      updatedAt: hoursAgo(72),
      lastUsedAt: hoursAgo(2),
      grantedUntil: new Date(Date.now() + 12 * 60_000).toISOString(),
    },
  ],
  [
    "STRIPE_API_KEY",
    { description: "", createdAt: hoursAgo(24), updatedAt: hoursAgo(24), lastUsedAt: null },
  ],
]);

export const vaultHandlers = [
  http.get("/api/vault", () =>
    HttpResponse.json({
      secrets: [...store.entries()]
        .map(([name, entry]) => ({ name, ...entry }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }),
  ),

  http.put("/api/vault/:name", async ({ params, request }) => {
    const name = String(params.name);
    const nameError = vaultNameError(name);
    if (nameError) return HttpResponse.json({ error: nameError }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as {
      value?: unknown;
      description?: unknown;
    };
    if (typeof body.value !== "string" || body.value.length === 0) {
      return HttpResponse.json({ error: "Value is required." }, { status: 400 });
    }
    if (body.value.length > VAULT_MAX_VALUE_LENGTH) {
      return HttpResponse.json(
        { error: `Value must be at most ${VAULT_MAX_VALUE_LENGTH} characters.` },
        { status: 400 },
      );
    }
    const description = typeof body.description === "string" ? body.description.trim() : undefined;
    if ((description?.length ?? 0) > VAULT_MAX_DESCRIPTION_LENGTH) {
      return HttpResponse.json(
        { error: `Description must be at most ${VAULT_MAX_DESCRIPTION_LENGTH} characters.` },
        { status: 400 },
      );
    }
    const now = new Date().toISOString();
    const existing = store.get(name);
    store.set(name, {
      description: description ?? existing?.description ?? "",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      grantedUntil: existing?.grantedUntil,
    });
    return HttpResponse.json({ ok: true });
  }),

  http.delete("/api/vault/:name", ({ params }) => {
    const name = String(params.name);
    if (!store.delete(name)) {
      return HttpResponse.json({ error: "Unknown secret." }, { status: 404 });
    }
    return HttpResponse.json({ ok: true });
  }),
];
