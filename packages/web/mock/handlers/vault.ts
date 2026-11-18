import {
  VAULT_MAX_DESCRIPTION_LENGTH,
  VAULT_MAX_VALUE_LENGTH,
  VAULT_PIN_PATTERN,
  type VaultPinState,
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

// The PIN lives in memory and starts unset, so the first save asks for one. Three
// wrong guesses lock it for 15 minutes, as the signer does.
let pin: string | null = null;
let failures = 0;
let lockedUntil = 0;

const lockedBody = () => ({ error: "locked", lockedUntil: new Date(lockedUntil).toISOString() });
const pinState = (): VaultPinState => ({
  set: pin !== null,
  lockedUntil: lockedUntil > Date.now() ? new Date(lockedUntil).toISOString() : null,
});

/** The refusal for a PIN that does not pass, or null when it does. */
function pinRefusal(given: unknown) {
  if (typeof given !== "string" || !VAULT_PIN_PATTERN.test(given)) {
    return HttpResponse.json({ error: "invalid_pin" }, { status: 400 });
  }
  if (pin === null) return HttpResponse.json({ error: "pin_not_set" }, { status: 409 });
  if (lockedUntil > Date.now()) return HttpResponse.json(lockedBody(), { status: 423 });
  if (given === pin) {
    failures = 0;
    return null;
  }
  failures += 1;
  if (failures >= 3) {
    failures = 0;
    lockedUntil = Date.now() + 15 * 60_000;
    return HttpResponse.json(lockedBody(), { status: 423 });
  }
  return HttpResponse.json({ error: "wrong_pin", attemptsLeft: 3 - failures }, { status: 403 });
}

export const vaultHandlers = [
  http.get("/api/vault", () =>
    HttpResponse.json({
      secrets: [...store.entries()]
        .map(([name, entry]) => ({ name, ...entry }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      pin: pinState(),
    }),
  ),

  http.post("/api/vault/pin", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
    if (typeof body.pin !== "string" || !VAULT_PIN_PATTERN.test(body.pin)) {
      return HttpResponse.json({ error: "invalid_pin" }, { status: 400 });
    }
    if (pin !== null) return HttpResponse.json({ error: "pin_already_set" }, { status: 409 });
    pin = body.pin;
    return HttpResponse.json({ ok: true });
  }),

  http.post("/api/vault/reset", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
    if (typeof body.pin !== "string" || !VAULT_PIN_PATTERN.test(body.pin)) {
      return HttpResponse.json({ error: "invalid_pin" }, { status: 400 });
    }
    store.clear();
    pin = body.pin;
    failures = 0;
    lockedUntil = 0;
    return HttpResponse.json({ ok: true });
  }),

  http.post("/api/vault/grants", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      names?: unknown;
      name?: unknown;
      ttlMinutes?: unknown;
      pin?: unknown;
    };
    const names = Array.isArray(body.names) ? body.names : [body.name];
    const entries = names.map((name) => (typeof name === "string" ? store.get(name) : undefined));
    if (entries.some((entry) => !entry) || typeof body.ttlMinutes !== "number") {
      return HttpResponse.json(
        { error: "This request changed or was already answered.", code: "stale_request" },
        { status: 409 },
      );
    }
    const refusal = pinRefusal(body.pin);
    if (refusal) return refusal;
    const until = new Date(Date.now() + body.ttlMinutes * 60_000).toISOString();
    for (const entry of entries) if (entry) entry.grantedUntil = until;
    return HttpResponse.json({ ok: true });
  }),

  http.put("/api/vault/:name", async ({ params, request }) => {
    const name = String(params.name);
    const nameError = vaultNameError(name);
    if (nameError) return HttpResponse.json({ error: nameError }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as {
      value?: unknown;
      description?: unknown;
      pin?: unknown;
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
    const refusal = pinRefusal(body.pin);
    if (refusal) return refusal;
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
