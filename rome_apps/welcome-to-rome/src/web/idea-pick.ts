// What "Build this" on the idea picker does. A card shown with `buildInChat:
// true` resolves and stays in this chat, where the welcome hands the build to
// the guardian's agent. Any other card opens a fresh chat with the idea's
// kickoff prompt in the composer and says so in its result: a card shown
// without an AI, and a card from before the build moved into this chat, whose
// props carry no `buildInChat`.

export interface IdeaPick {
  result: { ideaTitle: string; openedDraft?: true };
  /** The prompt to open a fresh chat with, or null to stay in this chat. */
  draft: string | null;
}

export function pickIdea(
  props: Record<string, unknown>,
  idea: { title: string; prompt: string },
): IdeaPick {
  if (props.buildInChat === true) return { result: { ideaTitle: idea.title }, draft: null };
  return { result: { ideaTitle: idea.title, openedDraft: true }, draft: idea.prompt };
}
