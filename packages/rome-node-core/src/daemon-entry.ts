import { serveDaemon } from "./daemon.js";
import { nodeConfigFromEnvironment } from "./local.js";

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await serveDaemon(nodeConfigFromEnvironment(process.env), controller.signal);
} catch {
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
