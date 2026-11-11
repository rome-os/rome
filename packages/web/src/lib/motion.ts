// `motion` takes easing as an array, not a CSS variable, so these mirror the
// `--rome-ease-*` tokens. Rules: docs/ui/motion.md.

export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
export const EASE_IN_OUT_TRAVEL = [0.45, 0, 0.1, 1] as const;

/** An object crossing the page. */
export const TRAVEL = { duration: 0.3, ease: EASE_IN_OUT_TRAVEL } as const;

/** A value changing in its own slot. */
export const ROLL = { duration: 0.2, ease: EASE_OUT_EXPO } as const;
