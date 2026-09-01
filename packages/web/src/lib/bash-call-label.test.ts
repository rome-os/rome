import { describe, expect, it } from "@rstest/core";
import { describeBashCall } from "./bash-call-label";

describe("describeBashCall", () => {
  it("describes read command actions", () => {
    const input = {
      command: "cat packages/web/package.json",
      commandActions: [
        {
          type: "read",
          command: "cat package.json",
          name: "package.json",
          path: "/repo/package.json",
        },
      ],
    };

    expect(describeBashCall(input, "inProgress")).toBe("Reading package.json");
    expect(describeBashCall(input, "completed")).toBe("Read package.json");
  });

  it("describes listFiles command actions", () => {
    const input = {
      commandActions: [{ type: "listFiles", command: "ls packages/web", path: "packages/web" }],
    };

    expect(describeBashCall(input, "inProgress")).toBe("Listing files in packages/web");
    expect(describeBashCall(input, "completed")).toBe("Listed files in packages/web");
  });

  it("describes search command actions", () => {
    const input = {
      commandActions: [
        { type: "search", command: "rg TODO packages/web", query: "TODO", path: "packages/web" },
      ],
    };

    expect(describeBashCall(input, "inProgress")).toBe('Searching for "TODO" in packages/web');
    expect(describeBashCall(input, "completed")).toBe('Search results for "TODO" in packages/web');
  });

  it("keeps unknown command actions on the existing label path", () => {
    const input = {
      command: "pnpm test",
      commandActions: [{ type: "unknown", command: "pnpm test" }],
    };

    expect(describeBashCall(input, "inProgress")).toBeNull();
    expect(describeBashCall(input, "completed")).toBeNull();
  });

  it("falls back to the inner command for unknown shell-wrapped calls", () => {
    const command = `/bin/zsh -lc "python - <<'PY'
from pathlib import Path
print(Path('.').resolve())
PY"`;

    expect(describeBashCall({ command }, "inProgress")).toBe(
      "python - <<'PY' from pathlib import Path print(Path('.').resolve()) PY",
    );
    expect(
      describeBashCall({ command: `/bin/sh -lc '/bin/zsh -lc "python --version"'` }, "completed"),
    ).toBe("python --version");
  });

  it("falls back to common command parsing when actions are absent", () => {
    expect(
      describeBashCall({ command: "sed -n '1,20p' packages/web/package.json" }, "inProgress"),
    ).toBe("Reading package.json");
    expect(describeBashCall({ command: "rg 'Using Bash' packages/web" }, "completed")).toBe(
      'Search results for "Using Bash"',
    );
  });

  it("treats rg --files as a list-files action", () => {
    expect(describeBashCall({ command: "rg --files packages/web" }, "inProgress")).toBe(
      "Listing files in packages/web",
    );
    expect(
      describeBashCall({ command: "rg --files -g '*.tsx' packages/web/src" }, "completed"),
    ).toBe("Listed files in .../web/src");
  });

  it("uses the first find path operand as the list-files scope", () => {
    expect(
      describeBashCall({ command: "find -L packages/web -type f -maxdepth 1" }, "inProgress"),
    ).toBe("Listing files in packages/web");
    expect(describeBashCall({ command: "find -type f" }, "completed")).toBe("Listed files");
    expect(
      describeBashCall({ command: "find packages/web -name '*.tsx' -maxdepth 1" }, "completed"),
    ).toBe("Listed files in packages/web");
    expect(describeBashCall({ command: "find -D search packages/web -type f" }, "completed")).toBe(
      "Listed files in packages/web",
    );
  });

  it("skips rg option values before deriving the search query", () => {
    expect(describeBashCall({ command: "rg --max-count 5 TODO packages/web" }, "inProgress")).toBe(
      'Searching for "TODO"',
    );
    expect(describeBashCall({ command: "rg -m5 TODO packages/web" }, "completed")).toBe(
      'Search results for "TODO"',
    );
    expect(describeBashCall({ command: "rg --regexp TODO packages/web" }, "completed")).toBe(
      'Search results for "TODO"',
    );
  });

  it("unwraps shell commands before deriving read labels", () => {
    const command =
      "/bin/zsh -lc \"sed -n '560,760p' /Users/yunfanye/work/rome-internal/packages/core/src/api/routes/webchat.ts && printf '\\n--- projects util/tests ---\\n' && sed -n '1,220p' /Users/yunfanye/work/rome-internal/packages/web/src/lib/chat-types.ts\"";

    expect(describeBashCall({ command }, "inProgress")).toBe("Reading webchat.ts + 1 more");
    expect(describeBashCall({ command }, "completed")).toBe("Read webchat.ts + 1 more");
  });

  it("splits multiline shell snippets into separate commands", () => {
    const command = '/bin/zsh -lc "cat packages/web/package.json\ncat packages/core/package.json"';

    expect(describeBashCall({ command }, "inProgress")).toBe("Reading package.json + 1 more");
    expect(describeBashCall({ command }, "completed")).toBe("Read package.json + 1 more");
  });

  it("ignores shell redirection targets when deriving read labels", () => {
    const command =
      "/bin/zsh -lc \"cat /Users/yunfanye/.rome/default/memory/IDENTITY.md 2>/dev/null; echo '---'; cat /Users/yunfanye/.rome/default/memory/MEMORY.md 2>/dev/null\"";

    expect(describeBashCall({ command }, "inProgress")).toBe("Reading IDENTITY.md + 1 more");
    expect(describeBashCall({ command }, "completed")).toBe("Read IDENTITY.md + 1 more");
    expect(describeBashCall({ command: "cat package.json 2> /dev/null" }, "inProgress")).toBe(
      "Reading package.json",
    );
    expect(
      describeBashCall({ command: "sed -n '1,20p' package.json 2> /dev/null" }, "completed"),
    ).toBe("Read package.json");
  });

  it("uses the reader input path before pipe filters", () => {
    const command =
      "/bin/zsh -lc \"nl -ba packages/web/src/components/agent-trace/AgentTrace.tsx | sed -n '200,235p' && echo '---' && nl -ba packages/web/src/components/chat/blocks/ThinkingBlock.tsx | sed -n '1,80p'\"";

    expect(describeBashCall({ command }, "inProgress")).toBe("Reading AgentTrace.tsx + 1 more");
    expect(describeBashCall({ command }, "completed")).toBe("Read AgentTrace.tsx + 1 more");
  });

  it("uses cat input paths before pipe filters", () => {
    const command =
      "/bin/zsh -lc \"cat AGENTS.md | sed -n '1,220p'; git diff -- packages/web/src/lib/bash-call-label.ts packages/web/src/lib/bash-call-label.test.ts\"";

    expect(describeBashCall({ command }, "inProgress")).toBe("Reading AGENTS.md");
    expect(describeBashCall({ command }, "completed")).toBe("Read AGENTS.md");
  });

  it("labels mutating cat or sed commands as writes", () => {
    expect(describeBashCall({ command: "cat package.json > copy.json" }, "inProgress")).toBe(
      "Writing copy.json",
    );
    expect(describeBashCall({ command: "cat > generated.txt" }, "completed")).toBe(
      "Wrote generated.txt",
    );
    expect(describeBashCall({ command: "cat package.json >>copy.json" }, "inProgress")).toBe(
      "Writing copy.json",
    );
    expect(describeBashCall({ command: "cat <<EOF" }, "completed")).toBeNull();
    expect(describeBashCall({ command: "sed -i 's/a/b/' package.json" }, "inProgress")).toBe(
      "Writing package.json",
    );
    expect(describeBashCall({ command: "sed -ni 's/a/b/' package.json" }, "completed")).toBe(
      "Wrote package.json",
    );
    expect(describeBashCall({ command: "sed -Eibak 's/a/b/' package.json" }, "completed")).toBe(
      "Wrote package.json",
    );
    expect(
      describeBashCall({ command: "sed --in-place=.bak 's/a/b/' package.json" }, "completed"),
    ).toBe("Wrote package.json");
  });

  it("labels temp-file heredoc writes by their later mv destination", () => {
    const command = `/bin/zsh -lc "cat > /tmp/thinking.new <<'EOF'
const label = \\"thinking.new\\";
EOF
mv /tmp/thinking.new packages/web/src/components/chat/blocks/ThinkingBlock.tsx
cat > packages/web/src/components/chat/blocks/ThinkingBlock.test.ts <<'"'EOF'
expect(true).toBe(true);
EOF
git diff -- packages/web/src/components/chat/blocks/ThinkingBlock.tsx packages/web/src/components/chat/blocks/ThinkingBlock.test.ts"`;

    expect(describeBashCall({ command }, "inProgress")).toBe("Writing ThinkingBlock.tsx + 1 more");
    expect(describeBashCall({ command }, "completed")).toBe("Wrote ThinkingBlock.tsx + 1 more");
  });

  it("unwraps shell heredocs that contain raw quotes before later mv commands", () => {
    const command = `/bin/zsh -lc "cat > /tmp/thinking.new <<'EOF'
<span className="min-w-0 truncate">{label}</span>
EOF
mv /tmp/thinking.new packages/web/src/components/chat/blocks/ThinkingBlock.tsx"`;

    expect(describeBashCall({ command }, "inProgress")).toBe("Writing ThinkingBlock.tsx");
    expect(describeBashCall({ command }, "completed")).toBe("Wrote ThinkingBlock.tsx");
  });

  it("uses grep regexp option values as search labels", () => {
    expect(describeBashCall({ command: "grep -e TODO packages/web" }, "inProgress")).toBe(
      'Searching for "TODO"',
    );
    expect(describeBashCall({ command: "grep --regexp TODO packages/web" }, "completed")).toBe(
      'Search results for "TODO"',
    );
    expect(describeBashCall({ command: "grep --regexp=TODO packages/web" }, "completed")).toBe(
      'Search results for "TODO"',
    );
  });

  it("skips grep option values before deriving the search query", () => {
    expect(describeBashCall({ command: "grep -m 5 TODO packages/web" }, "inProgress")).toBe(
      'Searching for "TODO"',
    );
    expect(describeBashCall({ command: "grep -C3 TODO packages/web" }, "completed")).toBe(
      'Search results for "TODO"',
    );
    expect(
      describeBashCall({ command: "grep --include '*.ts' TODO packages/web" }, "completed"),
    ).toBe('Search results for "TODO"');
    expect(describeBashCall({ command: "grep -I TODO packages/web" }, "inProgress")).toBe(
      'Searching for "TODO"',
    );
    expect(describeBashCall({ command: "grep --mmap TODO packages/web" }, "completed")).toBe(
      'Search results for "TODO"',
    );
  });

  it("does not split shell chains inside quoted grep patterns", () => {
    const command = "/bin/zsh -lc \"grep 'TODO;FIXME' packages/web && cat package.json\"";

    expect(describeBashCall({ command }, "inProgress")).toBe('Searching for "TODO;FIXME" + 1 more');
    expect(describeBashCall({ command }, "completed")).toBe(
      'Search results for "TODO;FIXME" + 1 more',
    );
  });

  it("unwraps shell commands before deriving git grep search labels", () => {
    const command =
      "/bin/zsh -lc 'git -C /Users/yunfanye/work/rome-internal grep -n \"Start chat from here\" -- packages/web packages/core rome_apps'";

    expect(describeBashCall({ command }, "inProgress")).toBe(
      'Searching for "Start chat from here"',
    );
    expect(describeBashCall({ command }, "completed")).toBe(
      'Search results for "Start chat from here"',
    );
  });

  it("skips git grep option values before deriving the search query", () => {
    const command = "/bin/zsh -lc 'git -C /repo grep -n -m 5 TODO -- packages/web packages/core'";

    expect(describeBashCall({ command }, "inProgress")).toBe('Searching for "TODO"');
    expect(describeBashCall({ command }, "completed")).toBe('Search results for "TODO"');
  });

  it("makes escaped grep alternation readable in labels", () => {
    const command =
      '/bin/zsh -lc \'git -C /Users/yunfanye/work/rome-internal grep -n "\\\"location.state\\\\|projectPath\\\\|newChat\\\"" -- packages/web\'';

    expect(describeBashCall({ command }, "inProgress")).toBe(
      'Searching for "location.state | projectPath | newChat"',
    );
  });

  it("labels cp commands as writes", () => {
    expect(
      describeBashCall({ command: "cp /tmp/source.png screenshots/Icon-3d.png" }, "inProgress"),
    ).toBe("Copying Icon-3d.png");
    expect(
      describeBashCall({ command: "cp /tmp/source.png screenshots/Icon-3d.png" }, "completed"),
    ).toBe("Copied Icon-3d.png");
    expect(describeBashCall({ command: "cp -r src/ dest/" }, "inProgress")).toBe("Copying dest");
  });

  it("keeps escaped quoted rg regexes together", () => {
    const command =
      '/bin/zsh -lc "rg -n \\"Start chat from here|chat from here|project.*select|select.*project|set.*project\\" /Users/yunfanye/work/rome-internal --glob \\"!node_modules\\" --glob \\"!dist\\" --glob \\"!build\\""';

    expect(describeBashCall({ command }, "inProgress")).toBe(
      'Searching for "Start chat from here | chat from here | project.*select | sel..."',
    );
  });
});
