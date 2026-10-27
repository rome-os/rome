import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EdgeTTS } from "node-edge-tts";
import { isCoreMainAgentId } from "@rome-os/app-runtime";
import type {
  AgentLifecycleHookDeps,
  AgentMessage,
  AgentRunnerInterface,
  AgentTurnFinishedEvent,
  AgentTurnFinishedHook,
  AppSettingsRepository,
  Logger,
  WebChatRecapRepository,
} from "@rome-os/app-runtime";
import {
  DEFAULT_RECAP_SETTINGS,
  getRecapSettings,
  RECAP_AUDIO_SPEED_RATES,
  RECAP_SCORE_THRESHOLDS,
  type RecapAudioSpeed,
  type RecapThreshold,
} from "../../settings.js";

export const RECAP_PROMPT = `Summarize the just-completed WebChat turn as a short spoken briefing I'll listen to. You are running in an isolated fork of the same conversation, so focus on the most recent completed turn; only reference earlier turns if needed for context.
Keep it to 2–3 sentences and under 300 characters when possible. Go longer only if there's genuinely more an executive needs to know. Cover only what's relevant from: the goal, what you did, any notable blockers or surprises, where things landed, and anything that needs my decision or review. Skip any point that doesn't apply — don't say "no issues found" or "nothing to review," just leave it out.
Write flowing prose, no bullets or markdown, no file paths or code. Conversational, like catching me up over coffee. Spell out symbols and acronyms so it sounds natural read aloud. Start directly with the summary — no preamble.`;

export interface RecapHookDeps {
  agentRunner: AgentRunnerInterface;
  webchatRecapRepo: WebChatRecapRepository;
  settingsRepo?: Pick<AppSettingsRepository, "get">;
  logger: Logger;
}

interface RecapAudio {
  audioUrl: string;
  audioMimeType: string;
}

export class RecapTurnFinishedHook implements AgentTurnFinishedHook {
  constructor(private readonly deps: RecapHookDeps) {}

  async onAgentTurnFinished(event: AgentTurnFinishedEvent): Promise<void> {
    if (!shouldRecapTurnShape(event)) return;

    try {
      const settings = await getRecapSettings(this.deps.settingsRepo);
      if (!settings.enabled) return;
      if (!meetsRecapThreshold(event, settings.threshold)) return;

      const webchatSessionId = resolveWebchatSessionId(event);
      const session = await this.deps.webchatRecapRepo.getSession(webchatSessionId);
      if (!session) {
        this.deps.logger.debug("skipping recap because webchat session was not found", {
          agentSessionId: event.turn.sessionId,
          webchatSessionId,
          turnId: event.turn.turnId,
        });
        return;
      }

      const content = await runForkedRecapTurn(this.deps.agentRunner, event);
      if (!content) return;

      let audio: RecapAudio | undefined;
      if (settings.createAudio) {
        try {
          audio = await createRecapAudio(content, event, settings.audioSpeed);
        } catch (err) {
          this.deps.logger.warn("failed to create recap audio", {
            sessionId: event.turn.sessionId,
            turnId: event.turn.turnId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await this.deps.webchatRecapRepo.addTurnRecapMessage({
        sessionId: webchatSessionId,
        turnId: event.turn.turnId,
        content,
        ...(audio ?? {}),
      });
    } catch (err) {
      this.deps.logger.warn("failed to generate turn recap", {
        sessionId: event.turn.sessionId,
        turnId: event.turn.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function shouldRecapTurn(event: AgentTurnFinishedEvent): boolean {
  return (
    shouldRecapTurnShape(event) && meetsRecapThreshold(event, DEFAULT_RECAP_SETTINGS.threshold)
  );
}

function shouldRecapTurnShape(event: AgentTurnFinishedEvent): boolean {
  const context = event.turn.threadContext;
  return (
    event.status === "completed" &&
    isCoreMainAgentId(event.turn.agentName) &&
    event.turn.parent === undefined &&
    event.turn.channelThreadKey?.startsWith("webchat:") === true &&
    context?.channel === "webchat" &&
    context.threadType === "private" &&
    event.output.state === "final"
  );
}

export function getRecapScore(event: AgentTurnFinishedEvent): number {
  return event.metrics.toolCallCount * 20 + event.output.text.trim().length;
}

export function meetsRecapThreshold(
  event: AgentTurnFinishedEvent,
  threshold: RecapThreshold,
): boolean {
  return getRecapScore(event) >= RECAP_SCORE_THRESHOLDS[threshold];
}

export function resolveWebchatSessionId(event: AgentTurnFinishedEvent): string {
  const threadId = event.turn.threadContext?.threadId?.trim();
  if (threadId) return threadId;

  const channelThreadKey = event.turn.channelThreadKey;
  if (channelThreadKey?.startsWith("webchat:")) {
    const [, sessionId] = channelThreadKey.split(":");
    if (sessionId) return sessionId;
  }

  return event.turn.sessionId;
}

export async function runForkedRecapTurn(
  agentRunner: AgentRunnerInterface,
  event: AgentTurnFinishedEvent,
): Promise<string> {
  let result = "";

  if (!event.turn.channelThreadKey) {
    throw new Error("Cannot fork recap turn without a channelThreadKey");
  }
  if (!agentRunner.runForked) {
    throw new Error("Recap hook requires an agent runner with fork support");
  }

  for await (const message of agentRunner.runForked({
    agentName: event.turn.agentName,
    sourceSessionId: event.turn.sessionId,
    prompt: RECAP_PROMPT,
    tier: "small",
    channelThreadKey: event.turn.channelThreadKey,
    threadContext: event.turn.threadContext,
    workingDir: resolveProjectRoot(event),
    parentTurnId: event.turn.turnId,
    label: "recap",
  })) {
    if (message.type === "result") {
      result = message.content;
    } else if (message.type === "error") {
      throw new Error(message.error);
    }
  }

  return normalizeRecapText(result);
}

export async function createRecapAudio(
  content: string,
  event: AgentTurnFinishedEvent,
  speed: RecapAudioSpeed = DEFAULT_RECAP_SETTINGS.audioSpeed,
): Promise<RecapAudio> {
  const projectPath = event.turn.threadContext?.projectPath;
  const threadPath = event.turn.threadContext?.threadPath;
  if (!projectPath || !threadPath) {
    throw new Error("WebChat project context is required for recap audio");
  }

  const projectRoot = dirname(dirname(threadPath));
  const turnDir = sanitizePathSegment(event.turn.turnId);
  const audioId = `${randomUUID()}.mp3`;
  const audioPath = join(projectRoot, ".rome", "recaps", turnDir, audioId);
  await mkdir(dirname(audioPath), { recursive: true });

  const tts = new EdgeTTS({
    voice: "en-US-AriaNeural",
    lang: "en-US",
    outputFormat: "audio-24khz-48kbitrate-mono-mp3",
    rate: RECAP_AUDIO_SPEED_RATES[speed],
    timeout: 15_000,
  });
  await tts.ttsPromise(content, audioPath);

  const file = await stat(audioPath);
  if (file.size <= 0) {
    throw new Error("Edge TTS produced an empty audio file");
  }

  const logicalPath = [
    "projects",
    ...projectPath.split("/").filter(Boolean),
    ".rome",
    "recaps",
    turnDir,
    audioId,
  ].join("/");

  return {
    audioUrl: `/api/projects/asset/${encodeURIComponent(audioId)}?path=${encodeURIComponent(logicalPath)}&v=${Date.now()}-${file.size}`,
    audioMimeType: "audio/mpeg",
  };
}

function resolveProjectRoot(event: AgentTurnFinishedEvent): string | undefined {
  const threadPath = event.turn.threadContext?.threadPath;
  return threadPath ? dirname(dirname(threadPath)) : undefined;
}

function normalizeRecapText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized || "default";
}

export function createHook(deps: AgentLifecycleHookDeps): AgentTurnFinishedHook {
  if (!deps.agentRunner) {
    throw new Error("Recap hook requires agentRunner");
  }
  if (!deps.appContext) {
    throw new Error("Recap hook requires appContext");
  }
  const webchatRecapRepo = deps.appContext.repositories.webchatRecaps;
  if (!webchatRecapRepo) {
    throw new Error("Recap hook requires appContext.repositories.webchatRecaps");
  }

  return new RecapTurnFinishedHook({
    agentRunner: deps.agentRunner,
    webchatRecapRepo,
    settingsRepo: deps.appContext.repositories.settings,
    logger: deps.logger,
  });
}
