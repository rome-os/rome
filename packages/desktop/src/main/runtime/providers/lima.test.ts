import { describe, expect, it, rs } from "@rstest/core";

rs.mock("../../logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import { sameImageRef, selectImagesToRemove } from "./lima";

describe("sameImageRef", () => {
  it("matches the qualified form nerdctl reports against the short form we configure", () => {
    // Observed from a real container: `nerdctl container inspect` reports
    // `.Image` as `docker.io/yunfanye/rome:latest`, while `DEFAULT_RUNTIME_IMAGE`
    // is `yunfanye/rome:latest`. A raw string compare never matches, which
    // silently defeats container reuse and recreates on every launch.
    expect(sameImageRef("docker.io/yunfanye/rome:latest", "yunfanye/rome:latest")).toBe(true);
  });

  it("matches Docker Hub's implicit library namespace", () => {
    expect(sameImageRef("docker.io/library/alpine:3.21", "alpine:3.21")).toBe(true);
  });

  it("still separates different tags", () => {
    // The whole point of the comparison is to notice when the pinned image
    // moves, so normalization must not blur the tag.
    expect(sameImageRef("docker.io/yunfanye/rome:latest", "yunfanye/rome:1.2.3")).toBe(false);
  });

  it("still separates different registries", () => {
    expect(sameImageRef("ghcr.io/yunfanye/rome:latest", "yunfanye/rome:latest")).toBe(false);
  });

  it("treats an untagged ref as :latest, which is what nerdctl reports back", () => {
    // A support or dev ROME_DESKTOP_IMAGE override is the plausible source of
    // an untagged value, and a mismatch here recreates the container on every
    // launch with nothing in the logs to say why.
    expect(sameImageRef("docker.io/yunfanye/rome:latest", "yunfanye/rome")).toBe(true);
  });

  it("accepts the index.docker.io spelling of Docker Hub", () => {
    expect(sameImageRef("index.docker.io/yunfanye/rome:latest", "yunfanye/rome:latest")).toBe(true);
  });

  it("does not mistake a registry port for a tag", () => {
    // Only the last path segment can carry the tag; `:5000` here is the host's
    // port, so this ref is untagged and must still normalize to :latest.
    expect(sameImageRef("registry.example:5000/rome", "registry.example:5000/rome:latest")).toBe(
      true,
    );
  });
});

describe("selectImagesToRemove", () => {
  // Observed on a real install after one app update. nerdctl prints
  // `{{.Repository}}:{{.Tag}}` one per line.
  const listed = ["yunfanye/rome:1.0.104", "yunfanye/rome:1.0.103", "yunfanye/rome:latest"];

  it("removes the other tags of the running image", () => {
    expect(selectImagesToRemove(listed, "yunfanye/rome:1.0.104")).toEqual([
      "yunfanye/rome:1.0.103",
      "yunfanye/rome:latest",
    ]);
  });

  it("never removes the running image, whichever spelling nerdctl reports", () => {
    // nerdctl answers with the qualified form while the config carries the
    // short one; a raw compare would delete the image out from under the
    // container that is running it.
    expect(
      selectImagesToRemove(["docker.io/yunfanye/rome:1.0.104"], "yunfanye/rome:1.0.104"),
    ).toEqual([]);
  });

  it("leaves other repositories alone", () => {
    // That VM is not exclusively ours.
    expect(
      selectImagesToRemove(["alpine:3.21", "ghcr.io/other/rome:1.0.0"], "yunfanye/rome:1.0.104"),
    ).toEqual([]);
  });

  it("skips entries without a usable tag", () => {
    // `<none>` is a dangling image, which the upgrade path's prune owns. An
    // empty tag is what an image pulled by digest lists as. Neither is a ref
    // rmi can act on, so passing either on only produces a confusing warning.
    expect(
      selectImagesToRemove(["<none>:<none>", "yunfanye/rome:"], "yunfanye/rome:1.0.104"),
    ).toEqual([]);
  });

  it("does not decide the release-build question", () => {
    // The manager gates on ROME_DESKTOP_IMAGE. This stays a pure "which of
    // these tags is not the running one" so the policy has one home.
    expect(selectImagesToRemove(["yunfanye/rome:1.0.103"], "yunfanye/rome")).toEqual([
      "yunfanye/rome:1.0.103",
    ]);
  });

  it("ignores the blank line nerdctl's trailing newline produces", () => {
    expect(
      selectImagesToRemove(["yunfanye/rome:1.0.103", "", "  "], "yunfanye/rome:1.0.104"),
    ).toEqual(["yunfanye/rome:1.0.103"]);
  });

  it("keeps a moving tag when that is what is running", () => {
    // A development build runs :latest. Nothing else should be swept up on
    // its behalf, and the pinned releases beside it are held on purpose.
    expect(selectImagesToRemove(listed, "yunfanye/rome:latest")).toEqual([
      "yunfanye/rome:1.0.104",
      "yunfanye/rome:1.0.103",
    ]);
  });
});
