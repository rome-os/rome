import {
  ComputerUseError,
  parseComputerUseObservation,
  sameComputerUseObservationRegion,
  type ComputerUseObservation,
} from "./protocol.js";

/** Materializes a validated wire delta as a standalone full snapshot without mutating either input. */
export function mergeComputerUseObservation(
  previous: ComputerUseObservation | undefined,
  incoming: ComputerUseObservation,
): ComputerUseObservation {
  const parsed = parseComputerUseObservation(incoming, incoming.sessionId);
  const current =
    parsed.region === undefined ? parsed : { ...parsed, region: { ...parsed.region } };
  const delta = current.delta;
  if (
    previous &&
    (current.region !== undefined || previous.region !== undefined) &&
    (current.stateVersion <= previous.stateVersion ||
      (!sameComputerUseObservationRegion(previous.region, current.region) &&
        (delta?.mode !== "full" || delta.lineageId === previous.delta?.lineageId)))
  )
    throw new ComputerUseError(
      "invalid_helper_response",
      "Changing the observation region requires a new full lineage with a newer version.",
    );
  if (!delta) return { ...current, elements: current.elements.map((element) => ({ ...element })) };
  if (previous && previous.sessionId !== current.sessionId)
    throw new ComputerUseError(
      "invalid_helper_response",
      "A state baseline belongs to another session.",
    );
  if (delta.mode === "full") {
    if (
      previous?.delta?.lineageId === delta.lineageId &&
      current.stateVersion <= previous.stateVersion
    )
      throw new ComputerUseError(
        "invalid_helper_response",
        "A full snapshot cannot roll its lineage backward.",
      );
    return {
      ...current,
      elements: current.elements.map((element) => ({ ...element })),
      delta: { ...delta, added: [...delta.added], changed: [], removed: [] },
    };
  }
  if (
    !previous ||
    !previous.complete ||
    previous.delta?.lineageId !== delta.lineageId ||
    previous.stateVersion !== delta.baseVersion
  )
    throw new ComputerUseError(
      "computer_state_baseline_missing",
      "Request a full observation before applying this state delta.",
    );
  const baseline = parseComputerUseObservation(previous, current.sessionId);
  const elements = new Map(baseline.elements.map((element) => [element.ref, { ...element }]));
  if (
    delta.added.some((ref) => elements.has(ref)) ||
    [...delta.changed, ...delta.removed].some((ref) => !elements.has(ref))
  )
    throw new ComputerUseError(
      "invalid_helper_response",
      "The state delta reuses or refers to an unknown element identity.",
    );
  for (const ref of delta.removed) elements.delete(ref);
  for (const element of current.elements) elements.set(element.ref, { ...element });
  if (elements.size > 512)
    throw new ComputerUseError(
      "invalid_helper_response",
      "The materialized state exceeds the element budget.",
    );
  const merged = [...elements.values()];
  return {
    ...current,
    elements: merged,
    delta: {
      ...delta,
      mode: "full",
      baseVersion: null,
      added: merged.map((element) => element.ref),
      changed: [],
      removed: [],
    },
  };
}
