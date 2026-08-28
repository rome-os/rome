// The Telegram user-account conferral setup, driven through the real
// SetupSession runtime with an injected login-handle fake (no GramJS, no
// network).
//
// Seams under test:
//   1. makeTelegramUserSetup's coroutine — prompt(apiId/apiHash/phone) →
//      send-code → prompt(code) → optional prompt(2FA password) with the
//      wrong-password re-prompt loop → terminal conferral of the serialized
//      session material + identity profile — observed via the session's
//      poll-able state and the single commit call.
//   2. Re-prompt loops: an invalid credential entry, a bad phone code, and a
//      wrong 2FA password each re-render the same form carrying the error.
//   3. Zero-durable-state teardown: cancel stops the login client and never
//      commits.
//   4. Discovery/re-attach: an in-flight login is reported as the grant's active
//      setup through the generic SetupManager surface.

import { describe, expect, it, rs } from "@rstest/core";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import {
  TelegramUserAuthError,
  type TelegramUserLoginHandle,
  type TelegramUserLoginOutcome,
  type TelegramUserSettings,
} from "../../channels/telegram-user.js";
import { SetupManager, type SetupRegistry } from "../setup/manager.js";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import type { Connection } from "../types.js";
import {
  makeTelegramUserDescriptor,
  makeTelegramUserSetup,
  telegramUserMaterialFromSettings,
  telegramUserProfileFromSettings,
} from "./telegram-user.js";

const ACCOUNT: TelegramUserSettings = {
  apiId: 12345,
  apiHash: "hash-secret",
  sessionString: "sess-secret",
  phoneNumber: "+15551234567",
  userId: "42",
  username: "@guardian",
  displayName: "Guardian",
  connectedAt: "2026-07-12T00:00:00.000Z",
};

function makeLoginFake(
  opts: {
    submitCode?: () => Promise<TelegramUserLoginOutcome>;
    submitPassword?: (password: string) => Promise<TelegramUserSettings>;
  } = {},
) {
  const handle = {
    sendCode: rs.fn(async () => ({ isCodeViaApp: true })),
    submitCode: rs.fn(
      opts.submitCode ??
        (async (): Promise<TelegramUserLoginOutcome> => ({
          status: "connected",
          account: ACCOUNT,
        })),
    ),
    submitPassword: rs.fn(opts.submitPassword ?? (async () => ACCOUNT)),
    stop: rs.fn(async () => {}),
  } satisfies TelegramUserLoginHandle;
  return handle;
}

const VALID_CREDS = {
  apiId: "12345",
  apiHash: "hash-secret",
  phoneNumber: "+1 (555) 123-4567",
};

/** Wait until the coroutine parks at a prompt whose first field is `name`. After
 *  a `provideInput`, the coroutine first passes through the `ctx.step`
 *  `presenting` snapshot before it reaches the next prompt, so the next input
 *  must wait for that prompt rather than fire against the transient state. */
async function waitForField(session: SetupSession, name: string): Promise<void> {
  await rs.waitFor(() => {
    const state = session.state;
    if (state.status !== "awaiting-input") throw new Error(`not awaiting input (${state.status})`);
    if (state.form.fields[0]?.name !== name) {
      throw new Error(`awaiting ${state.form.fields[0]?.name}, want ${name}`);
    }
  });
}

describe("makeTelegramUserSetup", () => {
  it("prompts credentials, sends the code, then confers on a code-only login", async () => {
    const login = makeLoginFake();
    const openLogin = rs.fn(() => login);
    const fn = makeTelegramUserSetup({ openLogin });
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    expect(session.state.status).toBe("awaiting-input");
    // The login client only opens once the guardian supplies credentials.
    expect(openLogin).not.toHaveBeenCalled();

    await session.provideInput(VALID_CREDS);
    // The phone number is normalized to `+digits` before it reaches the client.
    await rs.waitFor(() => expect(login.sendCode).toHaveBeenCalledWith("+15551234567"));
    expect(openLogin).toHaveBeenCalledWith(12345, "hash-secret");
    await rs.waitFor(() => {
      const state = session.state;
      if (state.status !== "awaiting-input") throw new Error("not awaiting the code");
      expect(state.form.fields[0].name).toBe("code");
    });

    await session.provideInput({ code: "12345" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    // The login client is stopped BEFORE the conferral commit (the registry
    // builds the real Talk from the ledger the moment the credential lands).
    expect(login.stop).toHaveBeenCalledTimes(1);
    expect(login.stop.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual({
      credential: { material: telegramUserMaterialFromSettings(ACCOUNT), expiresAt: "never" },
      profile: telegramUserProfileFromSettings(ACCOUNT),
      summary: {
        title: "Telegram account connected",
        body: ["Guardian is connected and can send and read messages as you."],
      },
    });
  });

  it("prompts for the 2FA password when Telegram requires it, re-prompting on a wrong one", async () => {
    const login = makeLoginFake({
      submitCode: rs.fn(
        async (): Promise<TelegramUserLoginOutcome> => ({
          status: "password_required",
          passwordHint: "the usual",
        }),
      ),
    });
    let attempts = 0;
    login.submitPassword.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new TelegramUserAuthError("PASSWORD_HASH_INVALID");
      return ACCOUNT;
    });
    const fn = makeTelegramUserSetup({ openLogin: () => login });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await session.provideInput(VALID_CREDS);
    await waitForField(session, "code");
    await session.provideInput({ code: "12345" });

    // The password prompt is a secret field carrying the hint in its copy.
    await waitForField(session, "password");
    const passwordState = session.state;
    if (passwordState.status !== "awaiting-input") throw new Error("not awaiting the password");
    expect(passwordState.form.fields[0].secret).toBe(true);
    expect(passwordState.form.instructions).toContain("the usual");

    // A wrong password re-prompts, carrying the GramJS error; no commit yet.
    await session.provideInput({ password: "wrong" });
    await rs.waitFor(() => {
      const state = session.state;
      if (state.status !== "awaiting-input") throw new Error("not re-prompting the password");
      expect(state.form.fields[0].name).toBe("password");
      expect(state.error).toBe("PASSWORD_HASH_INVALID");
    });
    expect(commit).not.toHaveBeenCalled();

    await session.provideInput({ password: "correct" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(login.submitPassword).toHaveBeenCalledTimes(2);
  });

  it("re-prompts with the error on an invalid phone code", async () => {
    const login = makeLoginFake();
    login.submitCode.mockImplementationOnce(async () => {
      throw new TelegramUserAuthError("PHONE_CODE_INVALID");
    });
    const fn = makeTelegramUserSetup({ openLogin: () => login });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await session.provideInput(VALID_CREDS);
    await waitForField(session, "code");

    await session.provideInput({ code: "00000" });
    await rs.waitFor(() => {
      const state = session.state;
      if (state.status !== "awaiting-input") throw new Error("not re-prompting the code");
      expect(state.form.fields[0].name).toBe("code");
      expect(state.error).toBe("PHONE_CODE_INVALID");
    });
    expect(commit).not.toHaveBeenCalled();

    await session.provideInput({ code: "12345" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("re-prompts with the error on invalid credentials before opening the login client", async () => {
    const login = makeLoginFake();
    const openLogin = rs.fn(() => login);
    const fn = makeTelegramUserSetup({ openLogin });
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();

    const rejected = await session.provideInput({
      apiId: "not-a-number",
      apiHash: "hash-secret",
      phoneNumber: "+15551234567",
    });
    expect(rejected.state.status).toBe("awaiting-input");
    if (rejected.state.status === "awaiting-input") {
      expect(rejected.state.error).toBe("API ID must be a positive integer.");
    }
    expect(openLogin).not.toHaveBeenCalled();

    await session.provideInput(VALID_CREDS);
    await rs.waitFor(() => expect(openLogin).toHaveBeenCalledTimes(1));
  });

  it("cancel mid-login stops the login client and runs no commit", async () => {
    const login = makeLoginFake();
    const fn = makeTelegramUserSetup({ openLogin: () => login });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await session.provideInput(VALID_CREDS);
    // Park at the code prompt (the login client is now open).
    await rs.waitFor(() => {
      const state = session.state;
      if (state.status !== "awaiting-input") throw new Error("not awaiting the code");
      expect(state.form.fields[0].name).toBe("code");
    });

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    await rs.waitFor(() => expect(login.stop).toHaveBeenCalled());
  });
});

// Discovery/re-attach is the generic protocol's job: an in-flight login setup
// must be reported as the grant's active setup through the SetupManager.
describe("Telegram-user setup discovery", () => {
  function makeRegistry(): SetupRegistry {
    const descriptor = makeTelegramUserDescriptor({ openLogin: () => makeLoginFake() });
    return {
      getDescriptor: (service) => (service === "telegram_user" ? descriptor : null),
      withGrantSection: (_s, _g, fn) => fn(),
      // Never reached in this test: the login parks at the code prompt and never
      // confers. Present only to satisfy SetupRegistry.
      confer: async () => ({ id: "conn-tgu" }) as unknown as Connection,
    };
  }

  it("reports an in-flight login as the session grant's active setup", async () => {
    const manager = new SetupManager({
      registry: makeRegistry(),
      personMappingRepo: {} as PersonMappingRepository,
    });

    const started = await manager.start({ service: "telegram_user" }, "session");
    expect(started.reattached).toBe(false);
    expect(started.state.status).toBe("awaiting-input");
    expect(manager.activeFor("telegram_user", "session")).toBe(started.cid);

    // Feed the credentials: the setup advances (the login is now in flight) and
    // stays discoverable at its current state.
    await manager.provideInput(started.cid, VALID_CREDS);
    expect(manager.activeFor("telegram_user", "session")).toBe(started.cid);

    // A duplicate start re-attaches instead of spawning a second login client.
    const again = await manager.start({ service: "telegram_user" }, "session");
    expect(again.reattached).toBe(true);
    expect(again.cid).toBe(started.cid);
  });
});
