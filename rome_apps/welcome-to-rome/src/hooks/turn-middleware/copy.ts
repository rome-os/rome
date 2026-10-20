// User-facing strings for the scripted conversation live in the app's locale
// modules. This adapter only interpolates runtime values.

import type { AppIdea } from "../../db/repositories/progress.js";
import { formatMessage, messagesFor, type WelcomeMessages } from "../../i18n/locales/index.js";
import type { WelcomeLocale } from "../../locale.js";

export interface WelcomeCopy {
  greet(guardianName: string, agentName: string): string;
  /** Used when setup stored no guardian name, so the card asks for it. */
  greetNoName(agentName: string): string;
  connectAiLead: string;
  /** What Rome can do, said once before the getting-to-know-you question. */
  capabilities: string;
  questionLead: string;
  savingMemoryLead: string;
  ideasHandoffLead: string;
  ideasFailed: string;
  ideasOffline: string;
  unexpectedError: string;
  takeaway(summary: string): string;
  pickedIdea(idea: AppIdea): string;
  /** The build's opening brief: the idea's prompt, plus a request to ask the
   *  guardian through the question card, which parks the turn instead of
   *  ending the build. */
  buildBrief(idea: AppIdea): string;
  /** A picked idea with no AI connected: the build waits as a draft in a new chat. */
  pickedIdeaDraft(idea: AppIdea): string;
  /** The same, from an older card that drafted while an AI was connected. */
  pickedIdeaDraftReady(idea: AppIdea): string;
  finishedNoPick: string;
  /** Closes the welcome, as its own message after the first-app build. */
  finishedAfterBuild: string;
  alreadyDone: string;
}

// Every message ends on a full stop, question or exclamation mark, or an
// ellipsis. The memory agent's summary is model-written, so it gets one added
// when it stops short.
const END_PUNCTUATION = /[.!?…。！？」）)"”]$/;

export function withEndPunctuation(text: string, locale: WelcomeLocale): string {
  const trimmed = text.trimEnd();
  if (!trimmed || END_PUNCTUATION.test(trimmed)) return trimmed;
  return `${trimmed}${locale === "zh-CN" ? "。" : "."}`;
}

function serverCopy(locale: WelcomeLocale): WelcomeMessages["server"] {
  return messagesFor(locale).server;
}

export function copyFor(locale: WelcomeLocale): WelcomeCopy {
  const copy = serverCopy(locale);
  return {
    greet: (guardianName, agentName) => formatMessage(copy.greet, { guardianName, agentName }),
    greetNoName: (agentName) => formatMessage(copy.greetNoName, { agentName }),
    connectAiLead: copy.connectAiLead,
    capabilities: copy.capabilities,
    questionLead: copy.questionLead,
    savingMemoryLead: copy.savingMemoryLead,
    ideasHandoffLead: copy.ideasHandoffLead,
    ideasFailed: copy.ideasFailed,
    ideasOffline: copy.ideasOffline,
    unexpectedError: copy.unexpectedError,
    takeaway: (summary) =>
      formatMessage(copy.takeaway, { summary: withEndPunctuation(summary, locale) }),
    pickedIdea: (idea) => formatMessage(copy.pickedIdea, { title: idea.title }),
    buildBrief: (idea) => formatMessage(copy.buildBrief, { prompt: idea.prompt }),
    pickedIdeaDraft: (idea) => formatMessage(copy.pickedIdeaDraft, { title: idea.title }),
    pickedIdeaDraftReady: (idea) => formatMessage(copy.pickedIdeaDraftReady, { title: idea.title }),
    finishedNoPick: copy.finishedNoPick,
    finishedAfterBuild: copy.finishedAfterBuild,
    alreadyDone: copy.alreadyDone,
  };
}
