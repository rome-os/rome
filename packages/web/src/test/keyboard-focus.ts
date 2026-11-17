import { fireEvent } from "@testing-library/react";

/**
 * Focuses `element` as the keyboard does, which jsdom cannot tell from any
 * other focus: the browser would draw its ring, so `:focus-visible` matches.
 * A tooltip opens only on such focus.
 */
export function keyboardFocus(element: Element): void {
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    return selector === ":focus-visible" ? this === element : matches.call(this, selector);
  };
  try {
    fireEvent.focus(element);
  } finally {
    Element.prototype.matches = matches;
  }
}
