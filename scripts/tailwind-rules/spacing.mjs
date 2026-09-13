/** Policy for spacing utility declarations produced by Tailwind. */

import valueParser from "postcss-value-parser";

export const SPACING_PROPERTIES = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-inline",
  "padding-inline-start",
  "padding-inline-end",
  "padding-block",
  "padding-block-start",
  "padding-block-end",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  "margin-block",
  "margin-block-start",
  "margin-block-end",
  "gap",
  "row-gap",
  "column-gap",
  "scroll-padding",
  "scroll-padding-top",
  "scroll-padding-right",
  "scroll-padding-bottom",
  "scroll-padding-left",
  "scroll-padding-inline",
  "scroll-padding-inline-start",
  "scroll-padding-inline-end",
  "scroll-padding-block",
  "scroll-padding-block-start",
  "scroll-padding-block-end",
  "scroll-margin",
  "scroll-margin-top",
  "scroll-margin-right",
  "scroll-margin-bottom",
  "scroll-margin-left",
  "scroll-margin-inline",
  "scroll-margin-inline-start",
  "scroll-margin-inline-end",
  "scroll-margin-block",
  "scroll-margin-block-start",
  "scroll-margin-block-end",
  "--tw-border-spacing-x",
  "--tw-border-spacing-y",
]);

const SPACING_CLASS = /^-?(?:(?:scroll-)?[pm][trblxyse]?|gap(?:-[xy])?|space-[xy]|border-spacing)-/;
const ROME_SPACING_TOKEN = /^--rome-space-(\d+)$/;
const ROME_BOX_SIZE_TOKEN = /^--rome-size-\d+$/;
const KEYWORD_LENGTH = /^(?:auto|inherit|initial|unset|revert)$/i;
const SANCTIONED_SPACING_TOKEN = /^--(?:control|field|badge|row)-/;
const SAFE_AREA_PADDING_TOKEN = /^--rome-(?:safe-area-(?:top|bottom)|mobile-header-height)$/;
const PADDING_PROPERTY = /^padding/;

export function spacingCandidates(selector) {
  return [...selector.matchAll(/\.((?:\\.|[^\s.#:[\]>+~,()])+)/g)]
    .map((match) => match[1].replace(/\\(.)/g, "$1"))
    .filter((candidate) => SPACING_CLASS.test(candidate.split(":").at(-1)));
}

function significant(nodes) {
  return nodes.filter((node) => node.type !== "space" && node.type !== "comment");
}

function variableName(node) {
  if (node.type !== "function" || node.value.toLowerCase() !== "var") return null;
  const nodes = significant(node.nodes);
  return nodes[0]?.type === "word" && nodes[0].value.startsWith("--") ? nodes[0].value : null;
}

function isVariable(node, name) {
  const nodes = significant(node.nodes ?? []);
  return variableName(node) === name && nodes.length === 1;
}

function isFunction(node, name, matchNodes) {
  return (
    node?.type === "function" &&
    node.value.toLowerCase() === name &&
    matchNodes(significant(node.nodes))
  );
}

function isProduct(node, left, right) {
  return isFunction(
    node,
    "calc",
    (nodes) =>
      nodes.length === 3 &&
      nodes[1].type === "word" &&
      nodes[1].value === "*" &&
      left(nodes[0]) &&
      right(nodes[2]),
  );
}

function isTailwindRosterValue(nodes, candidate, step) {
  const root = significant(nodes);
  if (root.length !== 1) return false;
  const token = `--rome-space-${step}`;
  if (isVariable(root[0], token)) return true;

  const utility = candidate?.split(":").at(-1) ?? "";
  const negative = utility.startsWith("-");
  const positiveToken = (node) => isVariable(node, token);
  const negativeToken = (node) =>
    isProduct(node, positiveToken, (factor) => factor.type === "word" && factor.value === "-1");
  const signedToken = negative ? negativeToken : positiveToken;
  if (negative && signedToken(root[0])) return true;

  const axis = utility.match(/^-?space-([xy])-/)?.[1];
  if (!axis) return false;
  const reversalToken = `--tw-space-${axis}-reverse`;
  const reversal = (node) => isVariable(node, reversalToken);
  const remainder = (node) =>
    isFunction(
      node,
      "calc",
      (parts) =>
        parts.length === 3 &&
        parts[0].type === "word" &&
        parts[0].value === "1" &&
        parts[1].type === "word" &&
        parts[1].value === "-" &&
        reversal(parts[2]),
    );
  return isProduct(root[0], signedToken, reversal) || isProduct(root[0], signedToken, remainder);
}

function collectVariables(nodes, variables = []) {
  for (const node of nodes) {
    const name = variableName(node);
    if (name) variables.push({ name, node });
    if (node.nodes) collectVariables(node.nodes, variables);
  }
  return variables;
}

function hasLiteralFallback(variable) {
  const nodes = significant(variable.node.nodes);
  const comma = nodes.findIndex((node) => node.type === "div" && node.value === ",");
  if (comma < 0) return false;
  return collectVariables(nodes.slice(comma + 1)).length === 0;
}

/** The policy finding for one compiled spacing declaration, or null. */
export function classifySpacingDeclaration({ candidate, property, value, spacing }) {
  const parsed = valueParser(value);
  const variables = collectVariables(parsed.nodes);
  if (variables.some(({ name }) => name === "--spacing" || ROME_BOX_SIZE_TOKEN.test(name))) {
    return "off-scale spacing";
  }

  const romeSpacingSteps = variables.flatMap(({ name }) => {
    const match = name.match(ROME_SPACING_TOKEN);
    return match ? [Number(match[1])] : [];
  });
  for (const step of romeSpacingSteps) {
    if (!spacing.has(step)) return "off-scale spacing";
  }
  if (romeSpacingSteps.length > 0) {
    if (
      romeSpacingSteps.length === 1 &&
      isTailwindRosterValue(parsed.nodes, candidate, romeSpacingSteps[0])
    ) {
      return null;
    }
    return "arbitrary spacing";
  }

  if (variables.some(hasLiteralFallback)) return "arbitrary spacing";

  const tokenNames = variables
    .map(({ name }) => name)
    .filter((token) => !token.startsWith("--rome-space-") && !token.startsWith("--tw-"));
  if (tokenNames.length > 0) {
    if (tokenNames.every((token) => SANCTIONED_SPACING_TOKEN.test(token))) return null;
    if (
      PADDING_PROPERTY.test(property) &&
      tokenNames.every((token) => SAFE_AREA_PADDING_TOKEN.test(token))
    ) {
      return null;
    }
    return "arbitrary spacing";
  }

  if (KEYWORD_LENGTH.test(value) || /^-?0(?:px)?$/i.test(value)) {
    return null;
  }
  return "arbitrary spacing";
}

function utilityContext(declaration) {
  for (let node = declaration.parent; node; node = node.parent) {
    if (node.type !== "rule") continue;
    const candidates = spacingCandidates(node.selector);
    if (candidates.length > 0) return { candidates, selector: node.selector };
  }

  // Tailwind points declarations expanded from `@apply` back at the applied
  // candidate in the original PostCSS input. That stable source range lets the
  // compiled-value rule retain the utility name even under a custom selector.
  const source = declaration.source;
  if (source?.start?.offset !== undefined && source.end?.offset !== undefined) {
    const authored = source.input.css
      .slice(source.start.offset, source.end.offset + 1)
      .trim()
      .replace(/[;}]+$/, "");
    if (SPACING_CLASS.test(authored.split(":").at(-1))) {
      return { candidates: [authored], selector: declaration.parent.selector };
    }
  }
  return null;
}

/** Require every emitted spacing utility to resolve through the sanctioned roster. */
export const spacingUtilityRule = {
  name: "spacing-utility-values",
  check({ root, context, report }) {
    const spacing = context.spacing;
    if (!(spacing instanceof Set) || spacing.size === 0) {
      throw new Error("spacing-utility-values requires a non-empty spacing Set");
    }

    const seen = new Set();
    root.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase();
      if (!SPACING_PROPERTIES.has(property)) return;

      const utility = utilityContext(declaration);
      if (!utility) return;
      const value = declaration.value.trim();
      for (const candidate of utility.candidates) {
        const reason = classifySpacingDeclaration({ candidate, property, value, spacing });
        if (!reason) continue;

        const key = `${candidate}\0${reason}`;
        if (seen.has(key)) continue;
        seen.add(key);
        report({
          candidate,
          selector: utility.selector,
          property,
          value,
          reason,
        });
      }
    });
  },
};
