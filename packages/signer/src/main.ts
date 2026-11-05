import { startSigner } from "./signer.js";

const audience = process.env.SIGNER_AUDIENCE;
const keyDir = process.env.SIGNER_KEY_DIR;
const socketPath = process.env.SIGNER_SOCKET;
if (!audience || !keyDir || !socketPath) {
  process.stderr.write("SIGNER_AUDIENCE, SIGNER_KEY_DIR and SIGNER_SOCKET are required.\n");
  process.exit(1);
}

const { jkt } = await startSigner({ audience, keyDir, socketPath });
process.stdout.write(`${JSON.stringify({ event: "signer_started", jkt })}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));
