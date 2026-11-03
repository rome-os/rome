import { describe, expect, it } from "@rstest/core";
import { parseAppKeysEnv } from "./parse-app-keys-env";

describe("parseAppKeysEnv", () => {
  it("parses comments, export, CRLF, quotes, equals signs and literal references", () => {
    const result = parseAppKeysEnv(
      [
        "# App credentials",
        "",
        " export FIRST_KEY = token== # comment",
        'SECOND_KEY="  secret#value  " # comment',
        "THIRD_KEY='${FIRST_KEY}'",
        "FOURTH_KEY=`$(command)`",
      ].join("\r\n"),
    );
    expect(result.entries?.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "FIRST_KEY", value: "token==" },
      { name: "SECOND_KEY", value: "  secret#value  " },
      { name: "THIRD_KEY", value: "${FIRST_KEY}" },
      { name: "FOURTH_KEY", value: "$(command)" },
    ]);
  });

  it("preserves multiline values and decodes newlines only inside double quotes", () => {
    const input = 'MULTILINE="first  \nsecond"\nESCAPES="a\\nb\\rc"\nLITERAL=\'a\\nb\'';
    const result = parseAppKeysEnv(input);
    expect(result.entries?.map(({ value }) => value)).toEqual([
      "first  \nsecond",
      "a\nb\rc",
      "a\\nb",
    ]);
    expect(parseAppKeysEnv(result.entries!.map(({ source }) => source).join("\n"))).toEqual(result);
  });

  it.each([
    ["not an assignment", "assignment"],
    ['KEY="unfinished', "quote"],
    ['KEY="value" extra', "quote"],
    ["GOOD_KEY=again", "duplicate"],
    ["KEY=", "emptyValue"],
    ['KEY=""', "emptyValue"],
    ["KEY= # comment", "emptyValue"],
    [`KEY=${"x".repeat(32769)}`, "longValue"],
    ["ROME_PROFILE=value", "name"],
    ["PATH=value", "name"],
    ["lowercase=value", "name"],
    ["1KEY=value", "name"],
  ])("rejects invalid input without returning a partial batch (%s)", (line, reason) => {
    const result = parseAppKeysEnv(`GOOD_KEY=secret\n${line}`);
    expect(result.entries).toBeUndefined();
    expect(result.error).toMatchObject({ line: 2, reason });
    expect(JSON.stringify(result.error)).not.toContain("secret");
  });

  it("counts physical lines after multiline values", () => {
    expect(parseAppKeysEnv('KEY="first\nsecond"\n# comment\ninvalid').error).toMatchObject({
      line: 4,
      reason: "assignment",
    });
  });

  it("accepts the value length limit and comment-only input", () => {
    expect(parseAppKeysEnv(`KEY=${"a".repeat(32768)}`).error).toBeUndefined();
    expect(parseAppKeysEnv("# comment\n\n")).toEqual({ entries: [] });
  });
});
