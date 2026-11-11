# Motion

How a surface changes state. Motion here shows that a thing changed and where it went. It is never decoration. The [duration](primitive-token/motion-duration-primitives.md) and [easing](primitive-token/motion-easing-primitives.md) docs hold the values.

## Pace

- **Feedback starts on the input.** A press, a hover, or a typed character answers at once and finishes within `--rome-duration-200`. No presentation delay comes before it.
- **Travel takes `--rome-duration-300`.** An object crossing the page uses `--rome-ease-in-out-travel`. Anything longer than `--rome-duration-300` needs a stated reason.
- **Filtering does not animate.** A list narrowing under a search answers in the next frame, because the guardian is reading the result, not watching it.

## Identity

- **A thing that changes place travels.** A card that moves between groups keeps its identity on the way, and its neighbors make room in the same transition.
- **A motion ends in the final place.** Nothing lands and then shifts again.
- **Only what changed moves.** The label beside a changing number stays still, and an unchanged digit stays still.

## Values and states

- **A changing word or number rolls in its own slot.** Two spans crossfading in place overlap and read as a smudge.
- **A control keeps its footprint across its states.** A button or an icon slot holds its size and position from idle through pending to done.
- **Result follows cause.** A status changes after the action that caused it, and never before the server confirms it.

## Real conditions

- **Every animation survives a retarget.** A state that changes mid-motion continues from the current position, never from the start.
- **A failure moves nothing.** The object stays where it was, and the failure reads in words.
- **Reduced motion removes movement, never information.** Under `prefers-reduced-motion: reduce`, every state still arrives, without travel or roll.
