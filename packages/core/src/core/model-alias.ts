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
