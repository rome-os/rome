// The stand-in's find_secret control: counts each given value in every file
// under one instance's folder, in the environment's shape:
// {places: {file: [count per value]}, total: [count per value]}.
// Usage: node find-secret.mjs <instance folder> <JSON list of values>.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [dir, json] = process.argv.slice(2);
const values = JSON.parse(json);
const count = (text, v) => (v ? text.split(v).length - 1 : 0);
const places = {};
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const text = readFileSync(p, "latin1");
      places[relative(dir, p)] = values.map((v) => count(text, v));
    }
  }
};
walk(dir);
const total = values.map((_, i) => Object.values(places).reduce((n, c) => n + c[i], 0));
process.stdout.write(`${JSON.stringify({ places, total })}\n`);
