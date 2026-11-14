/** Marks the image that opens a picture's viewer, so the viewer can find its neighbours. */
export const VIEWER_PICTURE_ATTR = "data-viewer-picture";

/** The root every ChatMarkdown render puts around one message part. */
const MESSAGE_ROOT = ".rome-markdown";

export interface ReplyPicture {
  /** The original address: what the viewer shows and Download saves. */
  src: string;
  alt: string;
}

/** Whether two reads of a message's pictures are the same list. */
export function samePictures(a: ReplyPicture[], b: ReplyPicture[]): boolean {
  return a.length === b.length && a.every((p, i) => p.src === b[i]?.src && p.alt === b[i]?.alt);
}

/**
 * Where the picture `src` is in `pictures` now. A picture may be listed twice,
 * so of the places that match, the one nearest `near` wins. A picture that is
 * gone leaves the nearest place that still exists, or -1 for an empty list.
 * Stepping from the place found by address, not by number, keeps a list that
 * changed under the viewer from skipping or repeating a picture.
 */
export function placeOf(pictures: ReplyPicture[], src: string, near: number): number {
  let best = -1;
  pictures.forEach((picture, i) => {
    if (picture.src === src && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
  });
  if (best >= 0) return best;
  return pictures.length === 0 ? -1 : Math.max(0, Math.min(pictures.length - 1, near));
}

/**
 * The pictures of the message part `trigger` sits in that open a viewer, in
 * document order, the place of `trigger` among them, and the message part's
 * root, which a viewer can watch for pictures that arrive. A linked picture and
 * a picture that failed to load open no viewer, so they carry no mark and are
 * not here. The DOM is read when asked, so a message that grew while it
 * streamed still gives its whole set. `trigger` outside a message part is a set
 * of one.
 */
export function replyPictures(trigger: Element | null): {
  pictures: ReplyPicture[];
  index: number;
  root: Element | null;
} {
  const root = trigger?.closest(MESSAGE_ROOT) ?? null;
  const marked = root
    ? Array.from(root.querySelectorAll<HTMLElement>(`[${VIEWER_PICTURE_ATTR}]`))
    : [];
  const pictures = marked.map((el) => ({
    src: el.dataset.viewerSrc ?? "",
    alt: el.dataset.viewerAlt ?? "",
  }));
  const index = trigger ? marked.indexOf(trigger as HTMLElement) : -1;
  return index < 0 ? { pictures: [], index: 0, root } : { pictures, index, root };
}
