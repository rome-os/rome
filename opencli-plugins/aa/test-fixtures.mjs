import { readFileSync } from "node:fs";
import { normalizeSearch } from "./aa-helpers.mjs";

export const fixture = (mode = "cash") =>
  JSON.parse(readFileSync(new URL(`./fixtures/${mode}.json`, import.meta.url), "utf8"));
export const argsFor = (mode = "cash", extra = {}) => ({
  from: mode.startsWith("round") ? "JFK" : "SFO",
  to: mode.startsWith("round") ? "LHR" : "DFW",
  depart: "2026-11-13",
  miles: mode.includes("award"),
  ...(mode.startsWith("round") ? { return: "2026-11-20", adults: 2 } : {}),
  ...extra,
});
export const searchFor = (mode = "cash", extra = {}) => normalizeSearch(argsFor(mode, extra));
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
      if (fn.name !== "readAaPage") throw new Error("Unexpected browser mutation");
      return structuredClone(frames[Math.min(reads++, frames.length - 1)]);
    },
  };
}
