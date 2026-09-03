import { describe, expect, it } from "@rstest/core";
import type { Chunk, Compilation } from "@rspack/core";
import { findEntryChunk } from "./manifestPlugin.js";

// A build that splits a runtime chunk out — any app with a dynamic import —
// emits two initial chunks. Only one of them holds the generated entry module
// and exports `mount`, so the manifest has to name that one.
function chunk(name: string): Chunk {
  return { name, canBeInitial: () => true } as unknown as Chunk;
}

function compilation(opts: { entryChunk: Chunk | null; chunks: Chunk[] }): Compilation {
  const entrypoint = { getEntrypointChunk: () => opts.entryChunk };
  return {
    chunks: opts.chunks,
    entrypoints: new Map([["index", entrypoint]]),
  } as unknown as Compilation;
}

describe("findEntryChunk", () => {
  it("picks the entrypoint's chunk, not whichever initial chunk comes first", () => {
    const runtime = chunk("612");
    const entry = chunk("index");

    // The runtime chunk leads the iteration order, which is what a source edit
    // can change underneath the build.
    const found = findEntryChunk(compilation({ entryChunk: entry, chunks: [runtime, entry] }));

    expect(found).toBe(entry);
  });

  it("picks the same chunk when the build emits only one", () => {
    const only = chunk("index");

    expect(findEntryChunk(compilation({ entryChunk: only, chunks: [only] }))).toBe(only);
  });

  it("reports no entry chunk rather than falling back to an arbitrary one", () => {
    const runtime = chunk("612");

    expect(findEntryChunk(compilation({ entryChunk: null, chunks: [runtime] }))).toBeNull();
  });
});
