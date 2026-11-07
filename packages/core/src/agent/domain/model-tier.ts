// The size of model a turn asks for. The model resolver maps a tier to a
// provider's model; the model port never sees it.

export type ModelTier = "large" | "medium" | "small";
