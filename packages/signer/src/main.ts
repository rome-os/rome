import { normalizeAudience, startSigner } from "./signer.js";

const keyDir = process.env.SIGNER_KEY_DIR;
const socketPath = process.env.SIGNER_SOCKET;
if (!process.env.SIGNER_AUDIENCE || !keyDir || !socketPath) {
  process.stderr.write("SIGNER_AUDIENCE, SIGNER_KEY_DIR and SIGNER_SOCKET are required.\n");
  process.exit(1);
}
let audience: string;
try {
  audience = normalizeAudience(process.env.SIGNER_AUDIENCE);
} catch {
  process.stderr.write("SIGNER_AUDIENCE must be an http(s) origin such as https://romeos.cc.\n");
  process.exit(1);
}

const { jkt } = await startSigner({ audience, keyDir, socketPath });
process.stdout.write(`${JSON.stringify({ event: "signer_started", jkt })}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
