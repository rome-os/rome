import type { TextCodec } from "./transport.js";

/** Returns a source offset. Rendering decorations never become source text. */
export function partBoundary(source: string, limit: number, codec: TextCodec): number {
  if (
    codec.length(codec.render(source, false)) <= limit &&
    codec.length(codec.render(source, true)) <= limit
  )
    return source.length;
  let end = 0;
  let readable = 0;
  for (const character of source) {
    const next = end + character.length;
    const prefix = source.slice(0, next);
    if (
      codec.length(codec.render(prefix, false)) > limit ||
      codec.length(codec.render(prefix, true)) > limit
    )
      break;
    end = next;
    if (/\s/u.test(character)) readable = end;
  }
  if (!end) throw new Error("Delivery codec cannot fit one source character");
  return readable >= end / 2 ? readable : end;
}
