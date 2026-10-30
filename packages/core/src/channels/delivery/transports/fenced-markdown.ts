import type { TextContext } from "../types.js";

/**
 * Renders Markdown source so each message shows its code as code. Code that
 * runs past the end of a message is closed there and opened again at the start
 * of the next. Code the next message closes, or ends, before any of it shows is
 * not opened again, so a closing fence alone shows nothing. An unfinished fence
 * in a preview is closed the same way, so the rendering never shrinks as the
 * source grows.
 *
 * `prose` rewrites the text outside fenced code, given the source as written.
 * Fenced code reaches the result as it is.
 */
export function renderFenced(
  source: string,
  context: TextContext | undefined,
  prose: (text: string, source: string) => string = (text) => text,
): string {
  let open = fenceAfter(context?.before ?? "");
  let rest = source;
  if (open) {
    const head = source.split("\n");
    const first = head.findIndex((line) => line.trim() !== "");
    if (first < 0) return "";
    if (closes(head[first]!, open)) {
      rest = head.slice(first + 1).join("\n");
      open = undefined;
    } else if (first === head.length - 1 && closing(head[first]!, open)) return "";
  }
  const lines = `${open ? `${open.line}\n` : ""}${rest}`.split("\n");
  const code: string[] = [];
  const outside: string[] = [];
  let fence: Fence | undefined;
  let block: string[] = [];
  for (const line of lines) {
    if (fence) {
      block.push(line);
      if (closes(line, fence)) {
        outside.push(placeholder(code, block.join("\n")));
        fence = undefined;
      }
      continue;
    }
    fence = opener(line);
    if (fence) block = [line];
    else outside.push(line);
  }
  if (fence) {
    // A trailing newline in the code would show as a blank last line, and a
    // closing fence that has begun to arrive is finished rather than shown
    // as code, so the rendering never shrinks as the source grows.
    const last = block.at(-1)!;
    if (block.length > 1 && (last === "" || closing(last, fence))) block.pop();
    block.push(fence.char.repeat(fence.length));
    outside.push(placeholder(code, block.join("\n")));
  }

  return prose(outside.join("\n"), source).replace(
    /\u0000(\d+)\u0000/g,
    (_, index: string) => code[Number(index)]!,
  );
}

/** An open code fence: its opening line, and what a closing line must repeat. */
interface Fence {
  line: string;
  char: string;
  length: number;
}

function opener(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return undefined;
  return { line, char: match[1]![0]!, length: match[1]!.length };
}

function closes(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1]![0] === fence.char && match[1]!.length >= fence.length;
}

/** Whether `line` is a closing fence of `fence` that has begun to arrive. */
function closing(line: string, fence: Fence): boolean {
  return new RegExp(`^ {0,3}\\${fence.char}+$`).test(line);
}

/** The fence still open at the end of `text`, if any. */
function fenceAfter(text: string): Fence | undefined {
  let fence: Fence | undefined;
  for (const line of text.split("\n")) {
    if (!fence) fence = opener(line);
    else if (closes(line, fence)) fence = undefined;
  }
  return fence;
}

/** Stores `block` in `code` and answers the token that stands for it. */
function placeholder(code: string[], block: string): string {
  code.push(block);
  return `\u0000${code.length - 1}\u0000`;
}
