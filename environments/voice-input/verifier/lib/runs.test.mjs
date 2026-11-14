import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { standInReason } from "./runs.mjs";

const ctx = (transcriberInUse) => ({ transcriber: "real", memo: { transcriberInUse } });

describe("standInReason", () => {
  it("lets a real provider through", () => {
    assert.equal(
      standInReason(
        ctx({
          environment: { provider: "soniox" },
          named: { provider: "Soniox", host: "stt-rt.soniox.com" },
        }),
      ),
      null,
    );
  });

  it("refuses the stand-in when the environment still runs it", () => {
    assert.match(
      standInReason(ctx({ environment: { provider: "stand-in", url: "ws://transcriber:8790" } })),
      /stand-in/,
    );
  });

  it("refuses the stand-in when Rome names its host", () => {
    assert.match(
      standInReason(
        ctx({
          environment: { provider: "soniox" },
          named: { provider: "Soniox", host: "transcriber:8790" },
        }),
      ),
      /stand-in's host/,
    );
  });
});
