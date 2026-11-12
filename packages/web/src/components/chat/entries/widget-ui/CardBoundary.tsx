import { Component, type ReactNode } from "react";

/** Shows `fallback` in place of a card that throws: the renderer failing to
 *  load, such as a tab left open across an update whose old chunk is gone, or
 *  A2UI refusing a card while drawing it. Kept out of the lazily loaded
 *  renderer so it also guards the load. */
export class CardBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
