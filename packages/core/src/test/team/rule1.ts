// Rule 1, the instance's half: the guardian saves a teammate's email the way the
// Settings page does, and the teammate's sign-in through the Rome Cloud visitor
// grant ends with the dashboard open and nothing more to do. An account not on
// the list is refused. Rome Cloud is the stand-in in ./stand-in-cloud.ts.
// The page's half is the web verifier beside SettingsTabPage.tsx.

import { COOKIE_NAME, createSession, VISITOR_COOKIE_NAME } from "../../access/auth.js";
import { createInstance, GUARDIAN } from "./instance.js";
import { browse, cookieOf, type Browsable } from "./callers.js";
import { startStandInCloud, type CloudAccount } from "./stand-in-cloud.js";

export const INVITED: CloudAccount = {
  accountId: "acct-invited",
  email: "invited@team-verifier.test",
};
export const UNINVITED: CloudAccount = {
  accountId: "acct-uninvited",
  email: "uninvited@team-verifier.test",
};

/** The calls the dashboard makes as it opens, each of which must succeed. */
const DASHBOARD_OPENING_CALLS = [
  "/api/auth/me",
  "/api/chat/sessions",
  "/api/apps",
  "/api/settings",
];

export interface Step {
  step: string;
  ok: boolean;
  detail: string;
}

export interface Rule1bResult {
  pass: boolean;
  invited: Step[];
  uninvited: Step[];
}

/**
 * A product the sign-in check is proven against instead of the one in the
 * tree. "guardian-session-for-everyone": the visitor callback also hands
 * every account it signs in the guardian's session cookie.
 */
export type Rule1StandIn = "guardian-session-for-everyone";

export interface Rule1bOptions {
  standIn?: Rule1StandIn;
}

/** The cookies that sign a browser in to the dashboard. */
const SESSION_COOKIES = [COOKIE_NAME, VISITOR_COOKIE_NAME];

interface SignIn {
  steps: Step[];
  /** Where the callback sent the browser, or null when the flow stopped before it. */
  landing: { status: number; location: string } | null;
  /** Every session cookie the callback set, as a Cookie header value, or null when it set none. */
  cookie: string | null;
  /** The names of the session cookies the callback set. */
  issued: string[];
}

function withGuardianSessionOnCallback(app: Browsable): Browsable {
  return {
    async request(input, init) {
      const response = await app.request(input, init);
      if (!String(input).includes("/api/auth/visitor/callback")) return response;
      const headers = new Headers(response.headers);
      headers.append("set-cookie", `${COOKIE_NAME}=${createSession(GUARDIAN.userId)}; Path=/`);
      return new Response(response.body, { status: response.status, headers });
    },
  };
}

async function signIn(
  app: Browsable,
  cloud: Awaited<ReturnType<typeof startStandInCloud>>,
  account: CloudAccount,
): Promise<SignIn> {
  const steps: Step[] = [];
  cloud.signInAs(account);
  const start = await browse(app, {
    method: "POST",
    path: "/api/auth/visitor/start",
    cookie: null,
    json: { scope: "dashboard", next: "/" },
  });
  const startBody = (await start.response.json().catch(() => null)) as {
    authorizeUrl?: string;
  } | null;
  steps.push({
    step: "the login page starts the Rome Cloud sign-in",
    ok: start.response.status === 200 && typeof startBody?.authorizeUrl === "string",
    detail: `${start.stage} ${start.response.status}`,
  });
  if (!startBody?.authorizeUrl) return { steps, landing: null, cookie: null, issued: [] };

  const authorize = await fetch(startBody.authorizeUrl, { redirect: "manual" });
  const back = authorize.headers.get("location");
  steps.push({
    step: `Rome Cloud signs ${account.email} in and sends the browser back`,
    ok: authorize.status === 302 && back !== null,
    detail: `${authorize.status}`,
  });
  if (!back) return { steps, landing: null, cookie: null, issued: [] };

  const callbackUrl = new URL(back);
  const callback = await browse(app, {
    method: "GET",
    path: `${callbackUrl.pathname}${callbackUrl.search}`,
    cookie: null,
  });
  // A cookie set to an empty value clears it, so only a value counts as issued.
  const sessions = (callback.response.headers.getSetCookie?.() ?? [])
    .map((header) => header.split(";")[0])
    .filter((pair) => {
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      return SESSION_COOKIES.includes(name) && value !== "";
    });
  return {
    steps,
    landing: {
      status: callback.response.status,
      location: callback.response.headers.get("location") ?? "",
    },
    cookie: sessions.length > 0 ? sessions.join("; ") : null,
    issued: sessions.map((pair) => pair.slice(0, pair.indexOf("="))),
  };
}

async function dashboardOpens(app: Browsable, cookie: string | null): Promise<Step[]> {
  const steps: Step[] = [];
  const bootstrap = await browse(app, { method: "GET", path: "/api/bootstrap", cookie });
  const phase = ((await bootstrap.response.json().catch(() => null)) as { phase?: string } | null)
    ?.phase;
  steps.push({
    step: "the dashboard's bootstrap says ready",
    ok: phase === "ready",
    detail: `${bootstrap.response.status} phase=${phase}`,
  });
  for (const path of DASHBOARD_OPENING_CALLS) {
    const call = await browse(app, { method: "GET", path, cookie });
    const body = await call.response.text();
    const anonymous = path === "/api/auth/me" && body.includes('"kind":"anonymous"');
    steps.push({
      step: `the dashboard reads ${path}`,
      ok: call.response.ok && !anonymous,
      detail: `${call.stage} ${call.response.status}${anonymous ? " anonymous" : ""}`,
    });
  }
  return steps;
}

export async function runRule1b(options: Rule1bOptions = {}): Promise<Rule1bResult> {
  const cloud = await startStandInCloud();
  const saved = {
    base: process.env.PANTHEON_BASE_ORIGIN,
    instance: process.env.PANTHEON_INSTANCE_ORIGIN,
  };
  process.env.PANTHEON_BASE_ORIGIN = cloud.origin;
  process.env.PANTHEON_INSTANCE_ORIGIN = "https://team.verifier.test";
  // Starts with an empty list: the guardian's save is what puts the email on it.
  const instance = await createInstance({ dashboardEmails: [] });
  const app =
    options.standIn === "guardian-session-for-everyone"
      ? withGuardianSessionOnCallback(instance.app)
      : instance.app;
  try {
    const save = await browse(app, {
      method: "PUT",
      path: "/api/dashboard-access",
      cookie: cookieOf("guardian"),
      json: { cloudEmailAccess: [INVITED.email] },
    });
    const listed = await browse(app, {
      method: "GET",
      path: "/api/dashboard-access",
      cookie: cookieOf("guardian"),
    });
    const list = (
      (await listed.response.json().catch(() => null)) as {
        cloudEmailAccess?: string[];
      } | null
    )?.cloudEmailAccess;
    const saveStep: Step = {
      step: `the guardian (${GUARDIAN.email}) saves the email the Settings page sends`,
      ok: save.response.ok && (list ?? []).includes(INVITED.email),
      detail: `${save.stage} ${save.response.status}, list=${JSON.stringify(list)}`,
    };

    const invitedSignIn = await signIn(app, cloud, INVITED);
    const landing = invitedSignIn.landing;
    const invited = [
      saveStep,
      ...invitedSignIn.steps,
      {
        step: "the instance signs the teammate in and sends the browser to the dashboard",
        ok:
          landing?.status === 302 &&
          !landing.location.includes("error") &&
          invitedSignIn.issued.includes(VISITOR_COOKIE_NAME),
        detail: landing
          ? `${landing.status} -> ${landing.location}, cookies ${JSON.stringify(invitedSignIn.issued)}`
          : "no callback reached",
      },
      ...(invitedSignIn.cookie ? await dashboardOpens(app, invitedSignIn.cookie) : []),
    ];

    const uninvitedSignIn = await signIn(app, cloud, UNINVITED);
    const opened = uninvitedSignIn.cookie ? await dashboardOpens(app, uninvitedSignIn.cookie) : [];
    const uninvited: Step[] = [
      ...uninvitedSignIn.steps,
      {
        step: "the instance refuses an account not on the list: no session, no dashboard",
        ok:
          uninvitedSignIn.issued.length === 0 &&
          !opened.some((s) => s.ok && s.step.includes("bootstrap")),
        detail: `${uninvitedSignIn.landing?.status} -> ${uninvitedSignIn.landing?.location}, ${
          uninvitedSignIn.issued.length > 0
            ? `session cookies set: ${uninvitedSignIn.issued.join(", ")}`
            : "no session cookie"
        }`,
      },
    ];

    return {
      pass: invited.every((s) => s.ok) && uninvited.every((s) => s.ok),
      invited,
      uninvited,
    };
  } finally {
    await instance.close();
    await cloud.close();
    if (saved.base === undefined) delete process.env.PANTHEON_BASE_ORIGIN;
    else process.env.PANTHEON_BASE_ORIGIN = saved.base;
    if (saved.instance === undefined) delete process.env.PANTHEON_INSTANCE_ORIGIN;
    else process.env.PANTHEON_INSTANCE_ORIGIN = saved.instance;
  }
}
