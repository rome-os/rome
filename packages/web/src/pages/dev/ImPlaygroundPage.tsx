import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/fetch-json";

const configSchema = z.object({
  platform: z.enum(["discord", "telegram", "feishu", "wechat"]),
  mode: z.enum(["edit", "blocks", "final"]),
  chunkSize: z.number(),
  step: z.number(),
  intervalMs: z.number(),
});
const stateSchema = z.object({
  config: configSchema,
  presets: z.record(z.string(), configSchema),
  busy: z.boolean(),
  error: z.string(),
  messages: z.array(
    z.object({ id: z.string(), text: z.string(), direction: z.string(), edited: z.boolean() }),
  ),
  calls: z.array(z.unknown()),
  receipts: z.array(z.unknown()),
  errors: z.array(z.string()),
});
type Config = z.infer<typeof configSchema>;
const queryKey = ["dev-im-playground"];

export default function ImPlaygroundPage() {
  const client = useQueryClient();
  const state = useQuery({
    queryKey,
    queryFn: async () =>
      stateSchema.parse(
        await fetchJson("/__im/state", { fallback: "Start the IM playground service to connect." }),
      ),
    refetchInterval: 250,
    retry: false,
  });
  const command = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      fetchJson(`/__im/${path}`, { method: "POST", json: body, fallback: "The operation failed." }),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  const [text, setText] = useState(
    "One conversation stream, different platform delivery. 中文 👋\n".repeat(3),
  );
  const [fault, setFault] = useState("none");
  const current = state.data;
  const disabled = !current || current.busy || command.isPending;
  return (
    <main className="min-h-screen bg-background text-foreground p-6 space-y-6">
      <header className="space-y-2">
        <a href="/dev" className="text-muted-foreground">
          ← Development
        </a>
        <h1 className="text-title">IM delivery playground</h1>
        <p className="text-muted-foreground">
          Send the same conversation through Discord, Telegram, Feishu or WeChat. State resets when
          you apply a configuration.
        </p>
      </header>
      {state.error && (
        <p role="alert">
          Start <code>./r pnpm dev:im</code> alongside <code>pnpm dev:all</code>, then retry.{" "}
          <Button onClick={() => void state.refetch()}>Retry</Button>
        </p>
      )}
      {current && (
        <ConfigForm
          key={JSON.stringify(current.config)}
          initial={current.config}
          presets={current.presets}
          disabled={disabled}
          apply={(body) => command.mutate({ path: "config", body })}
        />
      )}
      <section className="space-y-3">
        <label className="block space-y-2">
          Message
          <Textarea value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <label>
            Next outbound request{" "}
            <select
              aria-label="Fault"
              className="bg-background border border-border rounded-8 p-2"
              value={fault}
              onChange={(event) => setFault(event.target.value)}
            >
              <option value="none">No fault</option>
              <option value="reject">Reject</option>
              <option value="rate-limit">Rate limit</option>
              <option value="drop">Drop response after acceptance</option>
            </select>
          </label>
          {(
            [
              ["inbound", "Inject incoming"],
              ["send", "Send"],
              ["stream", "Stream"],
            ] as const
          ).map(([action, label]) => (
            <Button
              key={action}
              disabled={disabled || !text.trim()}
              onClick={() => command.mutate({ path: "run", body: { action, text, fault } })}
            >
              {label}
            </Button>
          ))}
          <Button
            variant="outline"
            disabled={!current?.busy || command.isPending}
            onClick={() => command.mutate({ path: "stop", body: {} })}
          >
            Stop
          </Button>
          <span role="status">{current?.busy ? "Delivering…" : "Ready"}</span>
        </div>
        <p className="text-muted-foreground">
          Inject an incoming message before sending on WeChat. Platform pacing remains active;
          update interval controls generated deltas.
        </p>
        {(command.error || current?.error) && (
          <p role="alert">{command.error?.message || current?.error}</p>
        )}
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-section">Conversation</h2>
          {current?.messages.map((message) => (
            <article
              key={`${message.direction}-${message.id}`}
              className="border border-border rounded-12 p-4 space-y-2"
            >
              <p className="text-muted-foreground">
                {message.direction === "in" ? "Incoming" : "Rome"} · {message.id}
                {message.edited && " · edited"}
              </p>
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
            </article>
          ))}
        </section>
        <section className="space-y-3">
          <h2 className="text-section">Requests and receipts</h2>
          <details>
            <summary>Delivery receipts ({current?.receipts.length ?? 0})</summary>
            <pre className="overflow-auto text-aux">
              {JSON.stringify(current?.receipts, null, 2)}
            </pre>
          </details>
          <pre className="overflow-auto max-h-[60vh] text-aux">
            {JSON.stringify(current?.calls, null, 2)}
          </pre>
        </section>
      </div>
    </main>
  );
}

function ConfigForm({
  initial,
  presets,
  disabled,
  apply,
}: {
  initial: Config;
  presets: Record<string, Config>;
  disabled: boolean;
  apply(config: Config): void;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <form
      className="flex flex-wrap items-end gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        apply(config);
      }}
    >
      <label className="space-y-2">
        Platform
        <select
          aria-label="Platform"
          className="block bg-background border border-border rounded-8 p-2"
          value={config.platform}
          onChange={(event) => setConfig(presets[event.target.value])}
        >
          {Object.keys(presets).map((platform) => (
            <option key={platform}>{platform}</option>
          ))}
        </select>
      </label>
      <label className="space-y-2">
        Delivery
        <select
          aria-label="Delivery mode"
          className="block bg-background border border-border rounded-8 p-2"
          value={config.mode}
          onChange={(event) => setConfig({ ...config, mode: event.target.value as Config["mode"] })}
        >
          <option value="edit" disabled={config.platform === "wechat"}>
            Typewriter
          </option>
          <option value="blocks">Complete chunks</option>
          <option value="final">Final only</option>
        </select>
      </label>
      {(
        [
          { key: "chunkSize", label: "Message length", min: 2, max: 4096 },
          { key: "step", label: "Delta size", min: 1, max: 512 },
          { key: "intervalMs", label: "Delta interval (ms)", min: 0, max: 2000 },
        ] as const
      ).map(({ key, label, min, max }) => (
        <label key={key} className="space-y-2">
          {label}
          <Input
            aria-label={label}
            type="number"
            min={min}
            max={max}
            required
            value={config[key]}
            onChange={(event) => setConfig({ ...config, [key]: event.target.valueAsNumber })}
          />
        </label>
      ))}
      <Button type="submit" disabled={disabled}>
        Apply & reset
      </Button>
    </form>
  );
}
