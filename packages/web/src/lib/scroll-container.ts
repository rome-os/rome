const SCROLLABLE_OVERFLOW_VALUES = new Set(["auto", "overlay", "scroll"]);

export function allowsVerticalScroll(overflowY: string): boolean {
  return SCROLLABLE_OVERFLOW_VALUES.has(overflowY);
}

function hasVerticalOverflow(element: Pick<HTMLElement, "clientHeight" | "scrollHeight">) {
  return element.scrollHeight - element.clientHeight > 1;
}

export function findScrollableYAncestor(
  start: HTMLElement,
  {
    boundary = null,
    fallback = null,
  }: {
    boundary?: HTMLElement | null;
    fallback?: Element | null;
  } = {},
): Element | null {
  let element = start.parentElement;
  while (element) {
    if (
      allowsVerticalScroll(window.getComputedStyle(element).overflowY) &&
      hasVerticalOverflow(element)
    ) {
      return element;
    }
    if (element === boundary) {
      break;
    }
    element = element.parentElement;
  }

  return fallback;
}
