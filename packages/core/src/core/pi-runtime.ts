import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";
import { qualifyPiModelId } from "./pi-model.js";

const log = createLogger("pi-runtime");

const PI_DISCOVERY_TIMEOUT_MS = 15_000;

export interface PiDiscoveredModel {
  /** Rome's exact, qualified model id. */
  id: string;
  upstreamProvider: string;
  modelId: string;
  name: string;
}

export interface PiDiscoveryResult {
  loggedIn: boolean;
  models: PiDiscoveredModel[];
  error?: string;
  unavailableReason?: "runtime" | "no_credentials" | "no_models" | "discovery_failed";
}

export type PiSdkModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

export interface PiModelRuntime {
  getAvailable(
    providerId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly PiSdkModel[]>;
}

export type CreatePiModelRuntime = (options?: { signal?: AbortSignal }) => Promise<PiModelRuntime>;

function isEligibleModel(model: PiSdkModel): boolean {
  // ModelRuntime is the Pi Coding Agent's catalog, rather than a general media
  // model catalog. Requiring text input excludes non-conversational entries;
  // every remaining API is exposed by Pi through its tool-enabled agent loop.
  return model.input.includes("text");
}

function publicDiscoveryError(): string {
  // Provider exceptions can contain request headers or proxy URLs. Status is a
  // guardian-facing API response, so never copy the raw exception into it.
  return "Pi model discovery failed. Open Pi in Terminal, repair its configuration, then refresh.";
}

/** Shared owner of Pi's credential-aware model catalog. It returns identities,
 * never credentials; Pi continues to read and refresh its own auth files. */
export class PiRuntimeManager {
  private runtime: PiModelRuntime | undefined;
  private available = new Map<string, PiSdkModel>();
  private snapshot: PiDiscoveryResult = {
    loggedIn: false,
    models: [],
    unavailableReason: "no_credentials",
  };

  constructor(
    private readonly createRuntime: CreatePiModelRuntime = ({ signal } = {}) =>
      ModelRuntime.create({ allowModelNetwork: false, signal }),
  ) {}

  getStatus(): PiDiscoveryResult {
    return {
      ...this.snapshot,
      models: this.snapshot.models.map((model) => ({ ...model })),
    };
  }

  async refresh(): Promise<PiDiscoveryResult> {
    // One deadline covers both runtime creation (which the SDK uses for its
    // initial availability/auth check) and the catalog read, so a stalled Pi
    // provider check can't hold the per-provider refresh lock indefinitely.
    const signal = AbortSignal.timeout(PI_DISCOVERY_TIMEOUT_MS);
    try {
      // Recreate on every explicit refresh so changes to Pi's auth.json and
      // models.json are observed without Rome reading or parsing either file.
      const runtime = await this.createRuntime({ signal });
      const models = (await runtime.getAvailable(undefined, { signal }))
        .filter(isEligibleModel)
        .sort((left, right) =>
          `${left.provider}\0${left.id}`.localeCompare(`${right.provider}\0${right.id}`),
        );

      this.runtime = runtime;
      this.available = new Map(
        models.map((model) => [qualifyPiModelId(model.provider, model.id), model]),
      );
      this.snapshot = {
        // For Pi, "logged in" means "has at least one usable model": Pi fronts
        // many upstreams and Rome only ever cares about models it can actually
        // run. `unavailableReason: "no_models"` distinguishes authenticated-but-
        // empty for consumers that need the finer state.
        loggedIn: models.length > 0,
        models: models.map((model) => ({
          id: qualifyPiModelId(model.provider, model.id),
          upstreamProvider: model.provider,
          modelId: model.id,
          name: model.name,
        })),
        ...(models.length === 0 ? { unavailableReason: "no_models" as const } : {}),
      };
    } catch (error) {
      // Log for field debugging, but keep the guardian-facing status sanitized:
      // provider exceptions can carry request headers or proxy URLs.
      log.warn("pi model discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.runtime = undefined;
      this.available.clear();
      this.snapshot = {
        loggedIn: false,
        models: [],
        error: publicDiscoveryError(),
        unavailableReason: "discovery_failed",
      };
    }
    return this.getStatus();
  }

  resolveAvailableModel(
    qualifiedId: string,
  ): { runtime: PiModelRuntime; model: PiSdkModel } | null {
    const model = this.available.get(qualifiedId);
    return this.runtime && model ? { runtime: this.runtime, model } : null;
  }
}
