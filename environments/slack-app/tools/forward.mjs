// Forwards loopback ports to services in the environment's network, so an
// address such as http://127.0.0.1:47100 means the same service on the host
// and inside an instance. Each instance shares this process's network
// namespace (docs in ../README.md).
//
// Usage: node forward.mjs 47100=pantheon:3100 47200=fake-slack:8080

import { connect, createServer } from "node:net";

for (const spec of process.argv.slice(2)) {
  const [listen, target] = spec.split("=");
  const [host, port] = target.split(":");
  createServer((client) => {
    const upstream = connect(Number(port), host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  }).listen(Number(listen), "127.0.0.1", () =>
    console.log(`forwarding 127.0.0.1:${listen} -> ${target}`),
  );
}
