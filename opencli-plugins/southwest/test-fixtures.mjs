import { readFileSync } from "node:fs";
import { normalizeSearch } from "./southwest-helpers.mjs";

export const fixture = (mode = "points") =>
  JSON.parse(readFileSync(new URL(`./fixtures/${mode}.json`, import.meta.url), "utf8"));
export const searchFor = (mode = "points", extra = {}) =>
  normalizeSearch({
    from: "OAK",
    to: "HOU",
    depart: "2026-11-13",
    ...(mode === "points" ? { points: true, adults: 2 } : { return: "2026-11-20" }),
    ...extra,
  });
export function mockPage(frames) {
  let reads = 0;
  let time = 0;
  const urls = [];
  return {
    urls,
    now: () => time,
    async goto(url) {
      urls.push(url);
    },
    async wait() {
      time += 1000;
    },
    async evaluate(fn) {
      if (fn.name !== "readSouthwestPage") throw new Error("Unexpected browser mutation");
      return structuredClone(frames[Math.min(reads++, frames.length - 1)]);
    },
  };
}
