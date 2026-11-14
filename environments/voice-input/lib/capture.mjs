// Turns one capture into the report `voice-env capture stop` prints: the
// browser's requests from the proxy, the server's outbound connections from
// tcpdump in Rome's network namespace, and what the stand-in transcriber
// received. Each request that carried audio is listed with where it went.
//
//   node capture.mjs <proxy-report.json> <tcpdump.txt> <context.json>
//
// context.json: { rome: [ip...], names: { ip: name }, standIn: {stats},
//   standInIp, startedAt }
import { readFileSync } from "node:fs";
import { sustainedUpload } from "./audio.mjs";

const [proxyFile, dumpFile, contextFile] = process.argv.slice(2);
const browser = JSON.parse(readFileSync(proxyFile, "utf8"));
const context = JSON.parse(readFileSync(contextFile, "utf8"));
const lines = readFileSync(dumpFile, "utf8").split("\n");

const romeIps = new Set(context.rome);
const names = { ...context.names };
const flows = new Map();
// Linux's ephemeral range. A connection Rome opened leaves from one of these
// ports; replies to connections into Rome (the dashboard's) leave from 8080.
const EPHEMERAL = 32768;

// DNS answers, from the verbose capture of Rome's resolver replies:
// "... 13588 q: A? example.org. 1/0/0 example.org. A 1.2.3.4 ..."
for (const m of lines.join("\n").matchAll(/q: (?:A|AAAA)\? (\S+?)\.? (.*)/g)) {
  for (const a of m[2].matchAll(/ (?:A|AAAA) ([0-9a-f.:]+)/g)) names[a[1]] ??= m[1];
}

const PACKET =
  /^(\d+\.\d+)\s+(?:\S+\s+(?:In|Out|M|B|P)\s+)?IP6?\s+(\S+)\.(\d+) > (\S+)\.(\d+):\s+(.*)$/;
for (const line of lines) {
  const m = PACKET.exec(line);
  if (!m) continue;
  const [, ts, src, sport, dst, dport, rest] = m;
  if (!romeIps.has(src) || romeIps.has(dst) || dst.startsWith("127.")) continue;
  if (Number(sport) < EPHEMERAL) continue;
  const len = Number(/length (\d+)/.exec(rest)?.[1] ?? 0);
  const key = `${dst}:${dport}`;
  const flow = flows.get(key) ?? {
    address: key,
    bytesUp: 0,
    packets: 0,
    upBySecond: {},
    first: ts,
    last: ts,
  };
  flow.bytesUp += len;
  flow.packets += 1;
  flow.last = ts;
  const s = Math.floor(Number(ts));
  flow.upBySecond[s] = (flow.upBySecond[s] ?? 0) + len;
  flows.set(key, flow);
}

const standInAudio = (context.standIn?.sessions ?? []).reduce((n, s) => n + s.audioBytes, 0);
const server = [...flows.values()].map((f) => {
  const ip = f.address.slice(0, f.address.lastIndexOf(":"));
  const host = names[ip] ?? null;
  let carriesAudio = false;
  let evidence;
  if (ip === context.standInIp) {
    carriesAudio = standInAudio > 0;
    evidence = `the stand-in transcriber received ${standInAudio} bytes of audio in ${context.standIn?.sessions?.length ?? 0} sessions`;
  } else {
    const seconds = sustainedUpload(f.upBySecond);
    carriesAudio = seconds > 0;
    evidence = carriesAudio
      ? `sustained upload over ${seconds} seconds (${f.bytesUp} bytes)`
      : `${f.bytesUp} bytes up, not sustained`;
  }
  return {
    address: f.address,
    host,
    bytesUp: f.bytesUp,
    packets: f.packets,
    firstAt: new Date(Number(f.first) * 1000).toISOString(),
    lastAt: new Date(Number(f.last) * 1000).toISOString(),
    carriesAudio,
    evidence,
  };
});

const audio = [
  ...browser.requests
    .filter((r) => r.carriesAudio)
    .map((r) => ({
      side: "browser",
      to: r.request?.path ? `${r.host}${r.request.path}` : (r.url ?? r.host),
      host: r.host,
      evidence: r.evidence,
    })),
  ...server
    .filter((f) => f.carriesAudio)
    .map((f) => ({
      side: "server",
      to: f.host ?? f.address,
      host: f.host,
      address: f.address,
      evidence: f.evidence,
    })),
];

console.log(
  JSON.stringify(
    {
      window: { start: context.startedAt, end: new Date().toISOString() },
      audio,
      browser: browser.requests,
      server,
      standIn: context.standIn,
      method: {
        browser:
          "every request from the environment's Chrome passes its proxy; WebSocket frames on plain connections are read, encrypted connections are judged by sustained upload",
        server:
          "tcpdump in Rome's network namespace, packet sizes only, no payload; outbound means from an ephemeral port of Rome's container; hosts from Rome's own DNS answers",
      },
    },
    null,
    2,
  ),
);
