import {
  mergeComputerUseObservation,
  type ComputerUseObservation,
} from "@rome-os/node-core/computer-use";

type Element = ComputerUseObservation["elements"][number];
export type ComputerObservationView = "compact" | "detailed";
export interface ComputerObservationState {
  source: ComputerUseObservation;
  view: ComputerObservationView;
  subtreeRef?: string;
  projectedElements?: Element[];
}

function commonActionList(elements: Element[], key: "actions" | "axActions") {
  const counts = new Map<string, number>();
  let mostFrequent: string[] | undefined;
  let bestCount = 2;
  for (const element of elements) {
    const actions = element[key];
    if (!Array.isArray(actions) || !actions.every((action) => typeof action === "string"))
      return undefined;
    const encoded = JSON.stringify(actions);
    const count = (counts.get(encoded) ?? 0) + 1;
    counts.set(encoded, count);
    if (count > bestCount) {
      bestCount = count;
      mostFrequent = actions;
    }
  }
  return mostFrequent;
}

export function compactElementDefaults(elements: Element[]) {
  const defaults = { enabled: true, focused: false, secure: false, selectionSettable: false };
  const shared: [string, boolean | string[]][] = Object.entries(defaults).filter(
    ([key, value]) =>
      elements.length > 1 &&
      elements.every((element) => typeof element[key] === "boolean") &&
      elements.filter((element) => element[key] === value).length > 1,
  );
  for (const key of ["actions", "axActions"] as const) {
    const list = commonActionList(elements, key);
    if (list) shared.push([key, list]);
  }
  if (shared.length === 0) return { elements, elementDefaults: undefined };
  return {
    elementDefaults: Object.fromEntries(shared),
    elements: elements.map((element) => {
      const record = { ...element };
      for (const [key, value] of shared) {
        const field = record[key];
        if (
          field === value ||
          (Array.isArray(value) &&
            Array.isArray(field) &&
            value.length === field.length &&
            value.every((action, index) => field[index] === action))
        )
          delete record[key];
      }
      return record;
    }),
  };
}

function modelElement(element: Element, view: ComputerObservationView): Element {
  const result = { ...element };
  const { imageFrame } = result;
  if (
    Array.isArray(imageFrame) &&
    imageFrame.length === 4 &&
    imageFrame.every((part) => typeof part === "number" && Number.isFinite(part)) &&
    imageFrame[2] > 0 &&
    imageFrame[3] > 0
  ) {
    delete result.frame;
    delete result.windowFrame;
  }
  for (const key of ["title", "identifier"]) {
    if (result[key] === "") delete result[key];
  }
  for (const key of [
    "enabledAvailable",
    "focusedAvailable",
    "frameAvailable",
    "windowFrameAvailable",
    "selectedTextRangeAvailable",
    "readOnly",
    "valueSettable",
  ]) {
    delete result[key];
  }
  if (view === "detailed" && Array.isArray(result.axActions) && result.axActions.length === 0)
    delete result.axActions;
  if (result.valueType === "missing") delete result.valueType;
  if (result.identifierSource === "missing") delete result.identifierSource;
  for (const key of [
    "roleTruncated",
    "identifierTruncated",
    "titleTruncated",
    "valueTruncated",
    "valueOmitted",
    "childrenOmitted",
  ]) {
    if (result[key] === false) delete result[key];
  }
  return result;
}

const genericPointerActions = new Set(["move", "click", "drag", "scroll"]);

function layoutWrapper(element: Element, child: Element) {
  const selection = element.selectedTextRange;
  const emptySelection =
    Array.isArray(selection) && selection.length === 2 && selection[0] === 0 && selection[1] === 0;
  if (
    element.role !== "AXGroup" ||
    element.subrole ||
    element.enabled === false ||
    !Number.isSafeInteger(element.index) ||
    [element.title, element.value, element.identifier].some(
      (value) => value !== undefined && value !== "",
    ) ||
    (element.valueType !== "missing" && (element.valueOmitted || element.valueTruncated)) ||
    element.identifierTruncated ||
    element.titleTruncated ||
    element.roleTruncated ||
    element.secure ||
    element.childrenOmitted ||
    element.focused ||
    element.selected !== undefined ||
    element.expanded !== undefined ||
    (selection !== undefined && !emptySelection) ||
    element.selectionSettable ||
    element.valueSettable ||
    element.menuAncestor ||
    !Array.isArray(element.actions) ||
    (element.axActions !== undefined &&
      (!Array.isArray(element.axActions) || element.axActions.length > 0))
  )
    return false;
  const actions = element.actions;
  if (actions.length === 0) return true;
  // Keep a group that provides a usable hit area its only child does not provide.
  const childActions = child.actions;
  const frame = element.imageFrame;
  const childFrame = child.imageFrame;
  return (
    Array.isArray(childActions) &&
    actions.every((action) => genericPointerActions.has(action) && childActions.includes(action)) &&
    Array.isArray(frame) &&
    frame.length === 4 &&
    Array.isArray(childFrame) &&
    childFrame.length === 4 &&
    frame.every((coordinate, index) => coordinate === childFrame[index])
  );
}

function indexTree(elements: Element[]) {
  const byRef = new Map(elements.map((element) => [element.ref, element]));
  const children = new Map<string, Element[]>();
  const roots: Element[] = [];
  for (const element of elements) {
    const parent = element.parentRef;
    if (typeof parent !== "string" || !byRef.has(parent)) {
      roots.push(element);
    } else {
      const siblings = children.get(parent);
      if (siblings) siblings.push(element);
      else children.set(parent, [element]);
    }
  }
  return { byRef, children, roots };
}

function orderTree(roots: Element[], children: Map<string, Element[]>, fromEnd: boolean) {
  const indexOf = (element: Element) => (typeof element.index === "number" ? element.index : 0);
  const byTraversalOrder = (a: Element, b: Element) =>
    (indexOf(a) - indexOf(b)) * (fromEnd ? -1 : 1);
  const pending = roots.sort(byTraversalOrder).reverse();
  const ordered: Element[] = [];
  const visited = new Set<string>();
  while (pending.length) {
    const element = pending.pop()!;
    if (visited.has(element.ref)) return [];
    visited.add(element.ref);
    ordered.push(element);
    pending.push(...(children.get(element.ref) ?? []).sort(byTraversalOrder).reverse());
  }
  return ordered;
}

function selectSubtree(source: ComputerUseObservation, ref: string) {
  const { byRef, children } = indexTree(source.elements);
  const root = byRef.get(ref);
  if (!root) return undefined;
  const elements = orderTree(
    [{ ...root, parentRef: null }],
    children,
    source.region?.fromEnd === true,
  );
  return elements.length ? { ...source, elements } : undefined;
}

function compactTree({ elements, complete, region }: ComputerUseObservation): Element[] {
  const { byRef, children, roots } = indexTree(elements);
  const ordered = orderTree(roots, children, region?.fromEnd === true);
  if (ordered.length !== elements.length)
    return elements.map((element) => modelElement(element, "compact"));

  const wrappers = new Set<string>();
  for (const [ref, siblings] of children) {
    const element = byRef.get(ref)!;
    if (
      siblings.length === 1 &&
      (element.childCount === 1 ||
        (element.childCount === undefined && complete && region === undefined)) &&
      typeof element.parentRef === "string" &&
      byRef.has(element.parentRef) &&
      layoutWrapper(element, siblings[0])
    )
      wrappers.add(ref);
  }
  if (wrappers.size === 0) return elements.map((element) => modelElement(element, "compact"));

  return ordered.flatMap((element) => {
    if (wrappers.has(element.ref)) return [];
    let { parentRef, index } = element;
    while (typeof parentRef === "string" && wrappers.has(parentRef)) {
      ({ parentRef, index } = byRef.get(parentRef)!);
    }
    const record = modelElement(element, "compact");
    if (parentRef !== element.parentRef) {
      record.parentRef = parentRef;
      record.index = index;
    }
    return [record];
  });
}

export function presentComputerObservation(
  incoming: ComputerUseObservation,
  view: ComputerObservationView,
  previous?: ComputerObservationState,
  subtreeRef?: string,
) {
  const source = mergeComputerUseObservation(previous?.source, incoming);
  const selected = subtreeRef === undefined ? source : selectSubtree(source, subtreeRef);
  if (!selected) return undefined;
  const projectedElements =
    view === "compact"
      ? compactTree(selected)
      : subtreeRef === undefined
        ? undefined
        : selected.elements.map((element) => modelElement(element, "detailed"));
  const state: ComputerObservationState = { source, view, subtreeRef, projectedElements };
  const sameProjection = previous?.view === view && previous.subtreeRef === subtreeRef;
  const base = sameProjection ? incoming : source;
  if (!projectedElements)
    return {
      state,
      observation: {
        ...base,
        elements: base.elements.map((element) => modelElement(element, "detailed")),
      },
    };

  const delta = base.delta;
  if (!delta) return { state, observation: { ...base, elements: projectedElements } };
  if (delta.mode === "full") {
    return {
      state,
      observation: {
        ...base,
        elements: projectedElements,
        delta: { ...delta, added: projectedElements.map(({ ref }) => ref) },
      },
    };
  }

  const prior = new Map(previous?.projectedElements?.map((element) => [element.ref, element]));
  const current = new Set(projectedElements.map(({ ref }) => ref));
  const added: string[] = [];
  const changed: string[] = [];
  const elements = projectedElements.filter((element) => {
    const old = prior.get(element.ref);
    if (old === undefined) added.push(element.ref);
    else if (JSON.stringify(old) !== JSON.stringify(element)) changed.push(element.ref);
    else return false;
    return true;
  });
  const removed = [...prior.keys()].filter((ref) => !current.has(ref));
  return {
    state,
    observation: { ...base, elements, delta: { ...delta, added, changed, removed } },
  };
}
