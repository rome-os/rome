import { trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import winston from "winston";

const LOG_DIR = join(homedir(), ".rome-desktop");
export const LOG_FILE = join(LOG_DIR, "debug.log");
const TRACER_NAME = "rome-desktop";

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

const fileLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${(level as string).toUpperCase()} ${message as string}`;
    }),
  ),
  transports: [
    new winston.transports.File({
      filename: LOG_FILE,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 1,
      tailable: true,
    }),
  ],
});

function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME, "0.1.4");
}

/**
 * Structured logger for Rome.
 * Uses OTEL tracer for spans, falls back to file + console logging.
 */
export function createLogger(component: string) {
  const prefix = `[${component}]`;

  function writeLog(level: "info" | "warn" | "error", msg: string) {
    fileLogger.log(level, `${prefix} ${msg}`);
    if (level === "error") {
      console.error(`${prefix} ${msg}`);
    } else {
      console.log(`${prefix} ${msg}`);
    }
  }

  return {
    info(msg: string) {
      writeLog("info", msg);
    },

    warn(msg: string) {
      writeLog("warn", msg);
    },

    error(msg: string, err?: unknown) {
      const errMsg = err instanceof Error ? `: ${err.message}` : err ? `: ${err}` : "";
      writeLog("error", `${msg}${errMsg}`);
    },

    /**
     * Start an OTEL span. Returns the span for manual end().
     * Also logs the span name to file/console.
     */
    startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
      writeLog("info", `span:start ${name}`);
      const tracer = getTracer();
      const span = tracer.startSpan(`${component}.${name}`, {
        attributes: attributes ?? {},
      });
      return span;
    },

    /**
     * Run an async function inside an OTEL span.
     * Automatically records errors and ends the span.
     */
    async withSpan<T>(
      name: string,
      attributes: Record<string, string | number | boolean>,
      fn: (span: Span) => Promise<T>,
    ): Promise<T> {
      const span = this.startSpan(name, attributes);
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
        writeLog("info", `span:end ${name}`);
      }
    },
  };
}
