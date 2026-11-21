// Writes a self-signed TLS certificate for the given host names, so the fake
// Slack can answer as https://slack.com inside the environment's network.
// Containers trust it through NODE_EXTRA_CA_CERTS. Dependency-free: Node has
// no certificate builder, so this encodes the few DER structures a P-256
// certificate needs.
//
// Usage: node make-cert.mjs <out-dir> <host> [host...]

import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const len = body.length;
  const lenBytes =
    len < 0x80
      ? Buffer.from([len])
      : len < 0x100
        ? Buffer.from([0x81, len])
        : Buffer.from([0x82, len >> 8, len & 0xff]);
  return Buffer.concat([Buffer.from([tag]), lenBytes, body]);
};
const seq = (...p) => der(0x30, ...p);
const set = (...p) => der(0x31, ...p);
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [];
    let v = n;
    do {
      chunk.unshift(v & 0x7f);
      v >>= 7;
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const utf8 = (s) => der(0x0c, Buffer.from(s, "utf8"));
const time = (d) =>
  der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`));
const bool = (v) => der(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (b) => der(0x04, b);
const bits = (b) => der(0x03, Buffer.concat([Buffer.from([0]), b]));
const explicit = (n, inner) => der(0xa0 + n, inner);

/**
 * Makes a serial from random bytes that DER encodes as a positive INTEGER with
 * no padding: a zero first byte would be an illegal leading zero, and a set top
 * bit would make it negative.
 */
export function certSerial(bytes) {
  const serial = Buffer.from(bytes);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  return serial;
}

export function makeCert(hosts) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const name = seq(set(seq(oid("2.5.4.3"), utf8(`Slack app test environment (${hosts[0]})`))));
  const serial = certSerial(randomBytes(16));
  const now = new Date();
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  // An IPv4 address is an iPAddress name, any other a dNSName.
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  const san = seq(
    ...hosts.map((h) =>
      ipv4.test(h) ? der(0x87, Buffer.from(h.split(".").map(Number))) : der(0x82, Buffer.from(h)),
    ),
  );
  const extensions = explicit(
    3,
    seq(
      seq(oid("2.5.29.19"), bool(true), octets(seq(bool(true)))), // basicConstraints CA:TRUE, so it can anchor itself
      seq(oid("2.5.29.15"), bool(true), octets(der(0x03, Buffer.from([0x02, 0xa4])))), // keyUsage digitalSignature, keyEncipherment, keyCertSign
      seq(oid("2.5.29.37"), octets(seq(oid("1.3.6.1.5.5.7.3.1")))), // extKeyUsage serverAuth
      seq(oid("2.5.29.17"), octets(san)),
    ),
  );
  const tbs = seq(
    explicit(0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaSha256,
    name,
    seq(time(new Date(now.getTime() - 3600_000)), time(new Date(now.getTime() + 365 * 86400_000))),
    name,
    spki,
    extensions,
  );
  const signature = sign(
    "sha256",
    tbs,
    createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" })),
  );
  const cert = seq(tbs, ecdsaSha256, bits(signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outDir, ...hosts] = process.argv.slice(2);
  if (!outDir || hosts.length === 0) {
    console.error("usage: make-cert.mjs <out-dir> <host> [host...]");
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  const { cert, key } = makeCert(hosts);
  writeFileSync(join(outDir, "tls.crt"), cert);
  writeFileSync(join(outDir, "tls.key"), key, { mode: 0o600 });
}
