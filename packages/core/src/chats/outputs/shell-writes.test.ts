import { describe, expect, it } from "@rstest/core";
import { shellWrites } from "./shell-writes.js";

describe("shellWrites", () => {
  it("finds a redirect's target, appended or not", () => {
    expect(
      shellWrites("printf 'Hello, World!\\n' > hello-world.txt && ls -l hello-world.txt"),
    ).toEqual(["hello-world.txt"]);
    expect(shellWrites('echo "a b" >> "notes/my file.md"')).toEqual(["notes/my file.md"]);
    expect(shellWrites("echo hi >out.txt")).toEqual(["out.txt"]);
    expect(shellWrites("make &> build.log")).toEqual(["build.log"]);
  });

  it("finds what tee, touch, cp and mv write", () => {
    expect(shellWrites("echo hi | tee -a a.txt b.txt")).toEqual(["a.txt", "b.txt"]);
    expect(shellWrites("touch one.md two.md")).toEqual(["one.md", "two.md"]);
    expect(shellWrites("cp -r src/report.md /tmp/x/report-copy.md")).toEqual([
      "/tmp/x/report-copy.md",
    ]);
    expect(shellWrites("sudo mv draft.md final.md")).toEqual(["final.md"]);
  });

  it("finds nothing in a read, a descriptor, a device or a substitution", () => {
    expect(shellWrites("cat MEMORY.md")).toEqual([]);
    expect(shellWrites("ls 2>&1 | head")).toEqual([]);
    expect(shellWrites("cmd 2> /dev/null >&2")).toEqual([]);
    expect(shellWrites('echo x > "$OUT"')).toEqual([]);
    expect(shellWrites("echo x > out-*.txt")).toEqual([]);
    expect(shellWrites("sort < in.txt")).toEqual([]);
    expect(shellWrites("cp -t dest a.txt b.txt")).toEqual([]);
  });

  it("reads a here-document's target, not the lines inside it", () => {
    const command = "cat > page.html <<'EOF'\n<p>a > b</p>\necho no > nope.txt\nEOF\necho done";
    expect(shellWrites(command)).toEqual(["page.html"]);
  });

  it("reads the script a shell runs, as Codex wraps every command", () => {
    const command = `/usr/bin/bash -lc "printf 'Hello, World 2\\"'!'\\"\\\\n' > hello-world-2.txt && cat hello-world-2.txt"`;
    expect(shellWrites(command)).toEqual(["hello-world-2.txt"]);
    expect(shellWrites("bash -c 'echo hi | tee log.txt'")).toEqual(["log.txt"]);
  });

  it("finds the redirect after a stream's descriptor, and in each command of a chain", () => {
    expect(shellWrites("run 2> err.log; date > when.txt || true")).toEqual(["err.log", "when.txt"]);
  });
});
