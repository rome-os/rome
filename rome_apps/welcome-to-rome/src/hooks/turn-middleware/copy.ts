// User-facing strings for the scripted conversation live in the app's locale
// modules. This adapter only interpolates runtime values.

import type { AppIdea } from "../../db/repositories/progress.js";
import { formatMessage, messagesFor, type WelcomeMessages } from "../../i18n/locales/index.js";
import type { WelcomeLocale } from "../../locale.js";

export interface WelcomeCopy {
  greet(guardianName: string, agentName: string): string;
  connectAiLead: string;
  questionLead: string;
  savingMemoryLead: string;
  scoutsLead: string;
  ideasHandoffLead: string;
  ideasFailed: string;
  ideasOffline: string;
  unexpectedError: string;
  takeaway(summary: string): string;
  pickedIdea(idea: AppIdea): string;
  finishedNoPick: string;
  alreadyDone: string;
}

function serverCopy(locale: WelcomeLocale): WelcomeMessages["server"] {
  return messagesFor(locale).server;
}

export function copyFor(locale: WelcomeLocale): WelcomeCopy {
  const copy = serverCopy(locale);
  return {
    greet: (guardianName, agentName) => formatMessage(copy.greet, { guardianName, agentName }),
    connectAiLead: copy.connectAiLead,
    questionLead: copy.questionLead,
    savingMemoryLead: copy.savingMemoryLead,
    scoutsLead: copy.scoutsLead,
    ideasHandoffLead: copy.ideasHandoffLead,
    ideasFailed: copy.ideasFailed,
    ideasOffline: copy.ideasOffline,
    unexpectedError: copy.unexpectedError,
    takeaway: (summary) => formatMessage(copy.takeaway, { summary }),
    pickedIdea: (idea) => formatMessage(copy.pickedIdea, { title: idea.title }),
    finishedNoPick: copy.finishedNoPick,
    alreadyDone: copy.alreadyDone,
  };
}
