/** Matches the effort and dated aliases Codex accepts for a concrete model. */
export function matchesModelAlias(model: string, baseModel: string): boolean {
  const normalizedModel = model.toLowerCase();
  const normalizedBaseModel = baseModel.toLowerCase();
  if (
    normalizedModel === normalizedBaseModel ||
    normalizedModel.startsWith(`${normalizedBaseModel}:`)
  ) {
    return true;
  }

  const snapshotSuffix = normalizedModel.slice(`${normalizedBaseModel}-`.length);
  return (
    normalizedModel.startsWith(`${normalizedBaseModel}-`) &&
    /^\d{4}-\d{2}-\d{2}(?::.+)?$/.test(snapshotSuffix)
  );
}

/** The model name without Rome's legacy `:low`/`:medium`/`:high` effort
 *  suffix. Effort travels on its own field now; the suffix is accepted so
 *  stored selections keep resolving. */
export function stripLegacyReasoningSuffix(model: string): string {
  const idx = model.lastIndexOf(":");
  if (idx >= 0) {
    const suffix = model.slice(idx + 1);
    if (suffix === "low" || suffix === "medium" || suffix === "high") {
      return model.slice(0, idx);
    }
  }
  return model;
}
