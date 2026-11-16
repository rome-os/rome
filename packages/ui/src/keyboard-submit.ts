export interface KeyboardSubmitEvent {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
}

export interface KeyboardSubmitOptions {
  /**
   * Whether plain Enter submits at all. Defaults to true (desktop behavior:
   * Enter sends, Shift+Enter inserts a newline). Pass false on touch-first
   * devices, where the popular design is the opposite: the soft keyboard's
   * Enter inserts a newline and sending happens via the send button — both
   * because Shift+Enter is unavailable on soft keyboards and because an
   * accidental Enter shouldn't fire a half-written message.
   */
  enterSends?: boolean;
}

export function shouldSubmitOnEnter(
  event: KeyboardSubmitEvent,
  options: KeyboardSubmitOptions = {},
): boolean {
  if (options.enterSends === false) {
    return false;
  }
  if (event.key !== "Enter" || event.shiftKey) {
    return false;
  }

  return !isImeCompositionEvent(event);
}

export function isImeCompositionEvent(event: KeyboardSubmitEvent): boolean {
  return Boolean(
    event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.keyCode === 229 ||
      event.nativeEvent?.keyCode === 229,
  );
}
