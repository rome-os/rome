import { parseArgs } from "node:util";
import { requireBearer } from "./config.js";
import { getJson } from "./api.js";

const HELP = `Usage: rome whoami [options]

  --help, -h   Show this help.

Prints the Rome App Store account tied to the current CLI credentials: host, email,
the auth source (ROME_TOKEN or 30-day session), and the handles you can publish
under.`;

interface WhoamiResponse {
  user: { id: string; email: string; slug: string; isAdmin: boolean };
  handles: Array<{ handle: string; role: "owner" | "publisher" }>;
}

// Decode the `exp` claim out of a JWT without verifying — we only use it to
// display "session (expires in Nh)". Verification happens server-side.
function readJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(
      Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString("utf8"),
    );
    if (typeof json?.exp === "number") return json.exp * 1000;
    return null;
  } catch {
    return null;
  }
}

function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours === 0 ? `${days}d` : `${days}d${remainingHours}h`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

export async function runWhoami(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const bearer = await requireBearer();

  const body = await getJson<WhoamiResponse>(bearer.host, "/api/store/me", bearer);

  // When ROME_TOKEN is set we don't have a local config to read email from;
  // fall back to /api/store/me which always returns it.
  const email = bearer.email ?? body.user.email;

  let authLine: string;
  if (bearer.source === "env") {
    authLine = "ROME_TOKEN";
  } else {
    const expiryMs = readJwtExpiryMs(bearer.token);
    if (expiryMs && expiryMs > Date.now()) {
      authLine = `session (expires in ${formatRemaining(expiryMs - Date.now())})`;
    } else if (expiryMs) {
      authLine = "session (expired — re-run rome login)";
    } else {
      authLine = "session";
    }
  }

  const lines = [
    `host:   ${bearer.host}`,
    `email:  ${email}`,
    `slug:   ${body.user.slug}`,
    `auth:   ${authLine}`,
  ];
  if (body.user.isAdmin) lines.push(`role:   admin`);

  if (body.handles.length === 0) {
    lines.push(`handles: (none — your first publish will claim one)`);
  } else {
    const handles = body.handles
      .map((h) => `@${h.handle}${h.role === "owner" ? "" : ` (${h.role})`}`)
      .join(", ");
    lines.push(`handles: ${handles}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}
