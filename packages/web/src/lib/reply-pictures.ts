/** Marks the image that opens a picture's viewer, so the viewer can find its neighbours. */
export const VIEWER_PICTURE_ATTR = "data-viewer-picture";

/** The root every ChatMarkdown render puts around one message part. */
const MESSAGE_ROOT = ".rome-markdown";

export interface ReplyPicture {
  /** The original address: what the viewer shows and Download saves. */
  src: string;
  alt: string;
}

/**
 * The pictures of the message part `trigger` sits in that open a viewer, in
 * document order, and the place of `trigger` among them. A linked picture and a
 * picture that failed to load open no viewer, so they carry no mark and are not
 * here. The DOM is read when asked, so a message that grew while it streamed
 * still gives its whole set. `trigger` outside a message part is a set of one.
 */
export function replyPictures(trigger: Element | null): {
  pictures: ReplyPicture[];
  index: number;
} {
  const root = trigger?.closest(MESSAGE_ROOT);
  const marked = root
    ? Array.from(root.querySelectorAll<HTMLElement>(`[${VIEWER_PICTURE_ATTR}]`))
    : [];
  const pictures = marked.map((el) => ({
    src: el.dataset.viewerSrc ?? "",
    alt: el.dataset.viewerAlt ?? "",
  }));
  const index = trigger ? marked.indexOf(trigger as HTMLElement) : -1;
  return index < 0 ? { pictures: [], index: 0 } : { pictures, index };
}
