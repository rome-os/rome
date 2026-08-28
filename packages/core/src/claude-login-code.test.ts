import { describe, expect, it } from "@rstest/core";
import {
  ClaudeLoginCodeValidationError,
  extractClaudeLoginCode,
  formatClaudeLoginCodeInput,
} from "./claude-login-code.js";

const CODE =
  "TEST.left+SEGMENT/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345#TEST~right=SEGMENT_abcdefghijklmnopqrstuvwxyz6789";

describe("formatClaudeLoginCodeInput", () => {
  it("submits sanitized codes as raw terminal input plus Enter", () => {
    expect(formatClaudeLoginCodeInput(CODE)).toBe(`${CODE}\r`);
  });

  it("strips accidental surrounding and wrapped whitespace", () => {
    expect(formatClaudeLoginCodeInput(`  ${CODE.replace("#", "\n#")}  `)).toBe(`${CODE}\r`);
  });
});

describe("extractClaudeLoginCode", () => {
  it("extracts the code from a pasted HTTPS callback URL with an encoded separator", () => {
    expect(
      extractClaudeLoginCode(
        `https://platform.claude.com/oauth/code/callback?code=${encodeURIComponent(CODE)}&state=ok`,
      ),
    ).toBe(CODE);
  });

  it("reassembles callback URLs whose # separator was parsed as a fragment", () => {
    const [left, right] = CODE.split("#");
    expect(
      extractClaudeLoginCode(
        `https://platform.claude.com/oauth/code/callback?code=${left}#${right}`,
      ),
    ).toBe(CODE);
  });

  it("ignores non-code fragment suffixes after an unescaped callback code separator", () => {
    const [left, right] = CODE.split("#");
    expect(
      extractClaudeLoginCode(
        `https://platform.claude.com/oauth/code/callback?code=${left}#${right}&state=ok`,
      ),
    ).toBe(CODE);
  });

  it("extracts a direct pasted code from surrounding quotes or labels", () => {
    expect(extractClaudeLoginCode(`"${CODE}"`)).toBe(CODE);
    expect(extractClaudeLoginCode(`Paste code here if prompted: ${CODE}`)).toBe(CODE);
    expect(extractClaudeLoginCode(`Paste code here if prompted: ${CODE}.`)).toBe(CODE);
  });

  it("extracts a direct pasted code split across whitespace around #", () => {
    expect(extractClaudeLoginCode(CODE.replace("#", "\n#\n"))).toBe(CODE);
  });

  it("does not corrupt plus signs in a pasted callback URL", () => {
    const [left, right] = CODE.split("#");
    expect(
      extractClaudeLoginCode(
        `https://platform.claude.com/oauth/code/callback?code=${left}%23${right}`,
      ),
    ).toBe(CODE);
    expect(
      extractClaudeLoginCode(
        `https://platform.claude.com/oauth/code/callback?code=${left}#${right}`,
      ),
    ).toBe(CODE);
  });

  it("rejects the original authorization URL instead of sending code=true", () => {
    expect(() =>
      extractClaudeLoginCode(
        "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y",
      ),
    ).toThrow(ClaudeLoginCodeValidationError);
  });

  it("rejects empty and short inputs", () => {
    expect(() => extractClaudeLoginCode("")).toThrow(ClaudeLoginCodeValidationError);
    expect(() => extractClaudeLoginCode("true")).toThrow(ClaudeLoginCodeValidationError);
    expect(() => extractClaudeLoginCode("abc1234567890#def4567890")).toThrow(
      ClaudeLoginCodeValidationError,
    );
  });

  it("rejects callback URLs without a code parameter", () => {
    expect(() => extractClaudeLoginCode("https://platform.claude.com/oauth/code/callback")).toThrow(
      ClaudeLoginCodeValidationError,
    );
  });

  it("rejects non-HTTPS callback URLs", () => {
    expect(() => extractClaudeLoginCode(`http://localhost/callback?code=${CODE}`)).toThrow(
      ClaudeLoginCodeValidationError,
    );
  });

  it("rejects other URL-shaped pastes instead of treating them as raw codes", () => {
    expect(() => extractClaudeLoginCode(`ftp://example.com/callback?code=${CODE}`)).toThrow(
      ClaudeLoginCodeValidationError,
    );
  });
});
