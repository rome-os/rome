import { randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import type { Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { type LaunchOptions, launchHelper, untilAbort } from "./launch.js";
import {
  type ActParams,
  authorizationPayload,
  ComputerUseError,
  type ConsentMode,
  type ControllerClaim,
  controllerFingerprint,
  createProof,
  type JsonObject,
  makeRequest,
  type Method,
  parseResponse,
  type RequestParams,
  type Results,
  type ScreenshotDescriptor,
  verifyProof,
} from "./protocol.js";

const MAX_UNANSWERED_REQUESTS = 256;

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ObserveOptions extends RequestOptions {
  element?: string;
  screenshot?: boolean;
}

type ObserveResult = Omit<Results["observe"], "screenshot"> & {
  screenshot?: ScreenshotDescriptor & { png: Buffer };
};

interface BridgeOptions extends LaunchOptions {
  handshakeTimeoutMs?: number;
  consentTimeoutMs?: number;
  requestTimeoutMs?: number;
  locale?: string;
  consentMode?: ConsentMode;
  controller?: ControllerClaim & {
    sign(payload: Buffer, signal: AbortSignal): Uint8Array | Promise<Uint8Array>;
  };
}

interface Reply<M extends Method> {
  result: Results[M];
  binary: Buffer;
}

interface PendingRequest {
  receiveMetadata(message: JsonObject): (binary: Buffer) => void;
  fail?: (reason: ComputerUseError) => void;
}

function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

function connectionError(cause: unknown): ComputerUseError {
  return cause instanceof ComputerUseError
    ? cause
    : new ComputerUseError("connection_closed", { cause });
}

function closesConnection(error: ComputerUseError): boolean {
  return (
    error.code === "invalid_frame" ||
    error.code === "frame_limit" ||
    error.code === "connection_closed" ||
    error.code === "authentication_failed" ||
    error.code === "auth_failed" ||
    error.code === "consent_denied" ||
    error.code === "key_revoked"
  );
}

export class ComputerUseBridge {
  #instanceId = "";
  #helperPid = 0;
  #failure?: ComputerUseError;
  #lastId = 0n;
  #requests = new Map<string, PendingRequest>();
  #listeners = new Set<(error: ComputerUseError) => void>();

  private constructor(
    private readonly socket: Socket,
    private readonly cleanup: () => void,
    private readonly timeoutMs: number,
  ) {
    const decoder = new FrameDecoder((message) => this.#receiveMetadata(message));
    const onData = (chunk: Buffer) => {
      try {
        decoder.push(chunk);
      } catch (cause) {
        this.#disconnect(connectionError(cause));
      }
    };
    socket.on("data", onData);
    socket.on("error", (cause) => this.#disconnect(connectionError(cause)));
    socket.once("end", () => {
      try {
        decoder.finish();
      } catch (cause) {
        this.#disconnect(connectionError(cause));
      }
      this.close();
    });
    socket.once("close", () => {
      socket.off("data", onData);
      this.close();
    });
  }

  static async launch(options: BridgeOptions): Promise<ComputerUseBridge> {
    const requestTimeout = options.requestTimeoutMs ?? 10_000;
    const handshakeTimeout = options.handshakeTimeoutMs ?? 4_000;
    // A session-only hello waits for consent before the helper sends its proof.
    const consentTimeout = options.consentTimeoutMs ?? 65_000;
    const { controller, locale, consentMode } = options;
    if (
      !validTimeout(requestTimeout) ||
      !validTimeout(handshakeTimeout) ||
      !validTimeout(consentTimeout) ||
      (controller !== undefined && typeof controller?.sign !== "function") ||
      (options.startupTimeoutMs !== undefined && !validTimeout(options.startupTimeoutMs))
    ) {
      throw new ComputerUseError("invalid_request");
    }

    const claim = controller && {
      publicKey: controller.publicKey,
      label: controller.label,
      scope: controller.scope,
    };
    const { socket, secret, cleanup } = await launchHelper(options);
    const bridge = new ComputerUseBridge(socket, cleanup, requestTimeout);
    const nonce = randomBytes(32);
    const context = { secret, nonce, hostPid: process.pid };
    try {
      const { result } = await bridge.#request(
        "hello",
        {
          nonce: nonce.toString("base64"),
          proof: createProof(context, "host"),
          locale,
          consentMode,
          controller: claim,
        },
        { timeoutMs: controller ? handshakeTimeout : consentTimeout },
        ({ instance, helperPid, helperProof }) => {
          if (!verifyProof(helperProof, context, "helper", helperPid, instance)) {
            throw new ComputerUseError("authentication_failed");
          }
        },
      );
      secret.fill(0);
      if ("challenge" in result) {
        if (
          !claim ||
          !controller ||
          result.fingerprint !== controllerFingerprint(claim.publicKey)
        ) {
          throw new ComputerUseError("auth_failed");
        }
        const payload = authorizationPayload(result, context.hostPid, claim, consentMode);
        const disconnected = new AbortController();
        const unsubscribe = bridge.onDisconnect((error) => disconnected.abort(error));
        let signature: Uint8Array;
        try {
          const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(60_000)]);
          signature = await untilAbort(() => controller.sign(payload, signal), signal);
          if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
            throw new ComputerUseError("auth_failed");
          }
        } finally {
          unsubscribe();
        }
        await bridge.#request(
          "authorize",
          { signature: Buffer.from(signature).toString("base64") },
          { timeoutMs: consentTimeout },
          (grant) => {
            if (
              grant.fingerprint !== result.fingerprint ||
              grant.scope !== claim.scope ||
              grant.locale !== result.locale ||
              (consentMode === "persistent_only" && grant.auth !== "persistent") ||
              ((consentMode ?? "session_only") === "session_only" && grant.enrolled)
            ) {
              throw new ComputerUseError("auth_failed");
            }
          },
        );
      } else if (claim) {
        throw new ComputerUseError("auth_failed");
      }
      if (bridge.#failure) throw bridge.#failure;
      bridge.#instanceId = result.instance;
      bridge.#helperPid = result.helperPid;
      return bridge;
    } catch (cause) {
      bridge.#disconnect(connectionError(cause));
      throw cause;
    } finally {
      secret.fill(0);
    }
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  get helperPid(): number {
    return this.#helperPid;
  }

  get closed(): boolean {
    return this.#failure !== undefined;
  }

  async status(options?: RequestOptions): Promise<Results["status"]> {
    const { result } = await this.#request("status", undefined, options, ({ instance }) => {
      if (instance !== this.instanceId) throw new ComputerUseError("invalid_frame");
    });
    return result;
  }

  async windows(application?: string, options?: RequestOptions): Promise<Results["windows"]> {
    const { result } = await this.#request(
      "windows",
      application === undefined ? undefined : { application },
      options,
    );
    return result;
  }

  async bind(window: number, options?: RequestOptions): Promise<Results["bind"]> {
    const { result } = await this.#request("bind", { window }, options, (bound) => {
      if (bound.window.window !== window) throw new ComputerUseError("invalid_frame");
    });
    return result;
  }

  async unbind(binding: string, options?: RequestOptions): Promise<Results["unbind"]> {
    const { result } = await this.#request("unbind", { binding }, options, (released) => {
      if (released.binding !== binding) throw new ComputerUseError("invalid_frame");
    });
    return result;
  }

  async observe(binding: string, options?: ObserveOptions): Promise<ObserveResult> {
    const { element, screenshot } = options ?? {};
    const { result, binary } = await this.#request(
      "observe",
      { binding, element, screenshot },
      options,
      (observed) => {
        if (
          observed.binding !== binding ||
          (element !== undefined && observed.tree.ref !== element) ||
          Boolean(observed.screenshot) !== (screenshot === true)
        ) {
          throw new ComputerUseError("invalid_frame");
        }
      },
    );
    const { screenshot: descriptor, ...observation } = result;
    return descriptor
      ? { ...observation, screenshot: { ...descriptor, png: binary } }
      : observation;
  }

  async act(params: ActParams, options?: RequestOptions): Promise<Results["act"]> {
    const binding = params?.binding;
    const { result } = await this.#request("act", params, options, (acted) => {
      if (acted.binding !== binding) throw new ComputerUseError("invalid_frame");
    });
    return result;
  }

  async cancel(options?: RequestOptions): Promise<Results["cancel"]> {
    const { result } = await this.#request("cancel", undefined, options);
    return result;
  }

  async stop(options?: RequestOptions): Promise<Results["stop"]> {
    const { result } = await this.#request("stop", undefined, options);
    return result;
  }

  close(): void {
    this.#disconnect(new ComputerUseError("connection_closed"));
  }

  onDisconnect(listener: (error: ComputerUseError) => void): () => void {
    if (this.#failure) listener(this.#failure);
    else this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #disconnect(error: ComputerUseError): void {
    if (this.#failure) return;
    this.#failure = error;
    this.socket.destroy();
    for (const request of this.#requests.values()) request.fail?.(error);
    this.#requests.clear();
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    try {
      this.cleanup();
    } catch {
      // Filesystem cleanup must not escape a socket event handler.
    }
    for (const listener of listeners) listener(error);
  }

  #receiveMetadata(message: JsonObject): (binary: Buffer) => void {
    if (this.#failure) throw this.#failure;
    if (message.id === null) {
      const error = parseResponse(message);
      if (!error.ok) throw new ComputerUseError(error.error.code);
    }
    const pending = typeof message.id === "string" ? this.#requests.get(message.id) : undefined;
    if (!pending) throw new ComputerUseError("invalid_frame");
    return pending.receiveMetadata(message);
  }

  async #request<M extends Method>(
    method: M,
    params: RequestParams[M],
    options?: RequestOptions,
    validate?: (result: Results[M]) => void,
  ): Promise<Reply<M>> {
    if (this.#failure) throw this.#failure;
    const { signal, timeoutMs = this.timeoutMs } = options ?? {};
    if (signal?.aborted) throw new ComputerUseError("request_aborted");
    if (!validTimeout(timeoutMs)) throw new ComputerUseError("invalid_request");
    if (this.#requests.size >= MAX_UNANSWERED_REQUESTS) {
      const error = new ComputerUseError("connection_closed", {
        cause: new ComputerUseError("request_timeout"),
      });
      this.#disconnect(error);
      throw error;
    }

    const id = String(++this.#lastId);
    const frame = encodeFrame(makeRequest(id, method, params));
    return new Promise((resolve, reject) => {
      const pending: PendingRequest & { finish?: (reply: Reply<M> | ComputerUseError) => void } = {
        receiveMetadata: (message) => {
          const response = parseResponse(message, method);
          if (response.ok) {
            validate?.(response.result);
            return (binary) => {
              this.#requests.delete(id);
              pending.finish?.({ result: response.result, binary });
            };
          }
          const error = new ComputerUseError(response.error.code);
          if (closesConnection(error)) throw error;
          return () => {
            this.#requests.delete(id);
            pending.finish?.(error);
          };
        },
        fail: (error) =>
          pending.finish?.(
            method === "act"
              ? new ComputerUseError("action_outcome_unknown", { cause: error })
              : error,
          ),
      };

      // A timed-out ID still owns its reply schema until the helper replies.
      const timer = setTimeout(
        () => pending.fail?.(new ComputerUseError("request_timeout")),
        timeoutMs,
      );
      const abort =
        signal &&
        addAbortListener(signal, () => pending.fail?.(new ComputerUseError("request_aborted")));
      pending.finish = (reply) => {
        clearTimeout(timer);
        abort?.[Symbol.dispose]();
        pending.finish = undefined;
        pending.fail = undefined;
        if (reply instanceof ComputerUseError) reject(reply);
        else resolve(reply);
      };

      this.#requests.set(id, pending);
      try {
        this.socket.write(frame);
      } catch (cause) {
        this.#disconnect(connectionError(cause));
      }
    });
  }
}
