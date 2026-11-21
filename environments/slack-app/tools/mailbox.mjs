// ctl.sh mailbox: the instance's relay mailbox address, as Rome Cloud hands it
// to the instance (POST /api/relay/mailboxes with the instance's own token).
// Runs as the instance (ctl.sh as-instance). Prints {depositUrl} only; the
// drain key stays out.

import { request } from "node:http";

const cloud = process.env.SLACKENV_CLOUD;
const socketPath = process.env.SLACKENV_SIGNER_SOCKET;
const token = await new Promise((resolve, reject) => {
  const req = request({ socketPath, path: "/v1/token", method: "POST" }, (res) => {
    let body = "";
    res.on("data", (c) => {
      body += c;
    });
    res.on("end", () => {
      const t = JSON.parse(body || "{}").token;
      t ? resolve(t) : reject(new Error(`signer answered ${res.statusCode}`));
    });
  });
  req.on("error", reject);
  req.end();
}).catch((error) => {
  console.log(JSON.stringify({ error: String(error.message) }));
  process.exit(1);
});
const r = await fetch(`${cloud}/api/relay/mailboxes`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
const body = await r.json().catch(() => null);
if (!r.ok || typeof body?.depositUrl !== "string") {
  console.log(
    JSON.stringify({ error: `Rome Cloud answered ${r.status}`, body: body?.error ?? null }),
  );
  process.exit(1);
}
console.log(JSON.stringify({ depositUrl: body.depositUrl }));
