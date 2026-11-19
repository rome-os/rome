import { appFeature } from "@rome/api-types/features";
import { isShown } from "@/lib/features";
import type { WidgetPlacement } from "./use-free-cells";

/** Whether a saved widget shows: an app widget whose app is a hidden feature
 *  does not. */
export function isPlacementShown(widget: WidgetPlacement): boolean {
  return widget.type !== "app" || !widget.targetId || isShown(appFeature(widget.targetId));
}
