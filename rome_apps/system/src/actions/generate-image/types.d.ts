export interface GenerateImageOutput {
  /** Absolute local path of the saved image (valid as a send_message attachment source). */
  imagePath: string;
  /** Dashboard asset URL serving the same file (renders inline in webchat markdown). */
  imageUrl: string;
  mimeType: string;
  /** Id of the image generation provider that produced the image (e.g. "codex"). */
  provider: string;
  /** The prompt the image model actually used, when it revised the input. */
  revisedPrompt?: string;
}

/** One prompt's outcome in a batch; `index` is the prompt's position in the input `prompts`. */
export type GenerateImageBatchItem =
  | ({ index: number; prompt: string; status: "ok" } & GenerateImageOutput)
  | { index: number; prompt: string; status: "error"; error: string };

export interface GenerateImageBatchOutput {
  /** One entry per input prompt, in input order. */
  results: GenerateImageBatchItem[];
  succeeded: number;
  failed: number;
}
