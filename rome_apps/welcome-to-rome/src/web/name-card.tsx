import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Check } from "lucide-react";
import { defineComponent, type AppComponentContext } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { getWelcomeCopy } from "@/lib/copy";

// The first card: the two names setup chose, prefilled so one tap confirms
// them. props: `{ guardianName, agentName }`. Submits `{ guardianName,
// agentName }`; the script writes both through the host's profile path. A
// blank field falls back to the prefilled value, so the card never submits an
// empty name.
function NameCard({ ctx }: { ctx: AppComponentContext }) {
  const copy = getWelcomeCopy(ctx.bootstrap.shell.locale);
  const initialGuardian = typeof ctx.props.guardianName === "string" ? ctx.props.guardianName : "";
  const initialAgent = typeof ctx.props.agentName === "string" ? ctx.props.agentName : "";
  const resolved = ctx.host.resolved;
  const [guardianName, setGuardianName] = useState(
    typeof ctx.result?.guardianName === "string" ? ctx.result.guardianName : initialGuardian,
  );
  const [agentName, setAgentName] = useState(
    typeof ctx.result?.agentName === "string" ? ctx.result.agentName : initialAgent,
  );

  const confirm = () => {
    if (resolved) return;
    const g = guardianName.trim() || initialGuardian;
    const a = agentName.trim() || initialAgent;
    ctx.host.submit({ guardianName: g, agentName: a }, copy.names.summary(g, a));
  };

  const inputClass =
    "h-9 w-full rounded-8 border border-border bg-surface px-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60";

  return (
    <div className="w-full max-w-md rounded-12 border border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {copy.names.guardianLabel}
          </span>
          <input
            className={inputClass}
            value={guardianName}
            disabled={resolved}
            autoComplete="name"
            onChange={(e) => setGuardianName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{copy.names.agentLabel}</span>
          <input
            className={inputClass}
            value={agentName}
            disabled={resolved}
            autoComplete="off"
            onChange={(e) => setAgentName(e.target.value)}
          />
        </label>
      </div>
      <Button size="sm" className="mt-3" disabled={resolved} onClick={confirm}>
        <Check /> {copy.names.confirm}
      </Button>
    </div>
  );
}

defineComponent("name-card", (container, ctx) => {
  const root = createRoot(container);
  root.render(<NameCard ctx={ctx} />);
  return () => root.unmount();
});
