import type { ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Hourglass, MessageSquare } from "lucide-react";
import { Page } from "@rome-os/ui/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { StatusIndicator } from "@/lib/connection-status";
import SettingsDialog from "@/pages/SettingsDialog";

// Prototype of the Slack connect flow (ZHA-228), on mock data only. One page
// walks every step through `?step=`: the Slack entry before the click, a
// stand-in for Slack's approve screen, the connected connection with its next
// steps, a still of Rome's hello message, and the cancelled, admin-pending and
// desktop states. English only until the flow is confirmed.

type Step = "entry" | "approve" | "connected" | "dm" | "cancelled" | "admin" | "desktop";

const WORKSPACE = "Acme";

export default function SlackConnectPrototypePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const step = (params.get("step") ?? "entry") as Step;
  const go = (next: Step, extra = "") => navigate(`/dev/connections/slack?step=${next}${extra}`);

  if (step === "approve")
    return <SlackApproveStandIn admin={params.get("admin") === "1"} go={go} />;
  if (step === "dm") return <SlackHelloStill go={go} />;

  return (
    <div className="min-h-dvh bg-background">
      <SettingsDialog onClose={() => navigate("/dev")}>
        <Page>
          {step === "connected" ? <ConnectedSlack go={go} /> : <SlackEntry step={step} go={go} />}
        </Page>
      </SettingsDialog>
    </div>
  );
}

// ── Before the click ────────────────────────────────────────────────────────

const FACTS: { label: string; body: string }[] = [
  { label: "Hears", body: "Direct messages to Rome, and messages that mention @rome." },
  { label: "Reads", body: "Only channels you invite it to." },
  { label: "Answers", body: "Only you, until you turn on Answer other members." },
  { label: "Does not", body: "Use its tools in Slack. That work stays on this dashboard." },
];

function Header({ status, action }: { status: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <Button type="button" variant="ghost" size="sm" className="-ml-2 self-start">
        <ArrowLeft data-icon="inline-start" aria-hidden />
        Connections
      </Button>
      <div className="flex items-center gap-3">
        <ConnectionBrandBadge connection="slack_app" />
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-foreground">Slack</h2>
          <div className="mt-1">{status}</div>
        </div>
        {action}
      </div>
    </div>
  );
}

function SlackEntry({ step, go }: { step: Step; go: (next: Step, extra?: string) => void }) {
  const admin = step === "admin";
  const desktop = step === "desktop";
  const status = admin
    ? { label: "Waiting for Slack", tone: "muted" as const }
    : { label: "Not connected", tone: "muted" as const };

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <Header
        status={<StatusIndicator status={status} />}
        action={
          desktop ? null : (
            <Button onClick={() => go("approve", admin ? "&admin=1" : "")}>Add to Slack</Button>
          )
        }
      />

      {step === "cancelled" ? (
        <Alert>
          <AlertTitle>Rome was not added to Slack</AlertTitle>
        </Alert>
      ) : null}
      {admin ? (
        <Alert>
          <Hourglass aria-hidden />
          <AlertTitle>Your Slack admin may need to approve Rome</AlertTitle>
          <AlertDescription>When they approve, press Add to Slack again.</AlertDescription>
        </Alert>
      ) : null}
      {desktop ? (
        <Alert>
          <ExternalLink aria-hidden />
          <AlertTitle>Slack's approve screen opens in your browser</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>This page updates on its own when you are done.</p>
            <Button size="sm" onClick={() => go("approve")}>
              Open Slack in the browser
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-6 sm:flex-row">
        <dl className="grid gap-4 sm:grid-cols-2">
          {FACTS.map((fact) => (
            <div key={fact.label}>
              <dt className="text-aux text-muted-foreground">{fact.label}</dt>
              <dd className="text-ui text-foreground">{fact.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// ── After the return ────────────────────────────────────────────────────────

function ConnectedSlack({ go }: { go: (next: Step) => void }) {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <Header
        status={
          <StatusIndicator status={{ label: `Connected to ${WORKSPACE}`, tone: "success" }} />
        }
      />

      <section className="space-y-3">
        <h3 className="text-ui font-semibold text-foreground">Next steps</h3>
        <ol className="divide-y divide-border rounded-8 border border-border">
          <li className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-ui text-foreground">Rome sent you a direct message</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => go("dm")}>
              <MessageSquare data-icon="inline-start" aria-hidden />
              Open in Slack
            </Button>
          </li>
          <li className="p-3">
            <p className="text-ui text-foreground">Invite Rome to a channel</p>
            <p className="text-aux text-muted-foreground">
              In that channel, type{" "}
              <code className="rounded-4 bg-surface-muted px-1 text-foreground">/invite @rome</code>
              .
            </p>
          </li>
          <li className="flex items-start gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="text-ui text-foreground">Answer other members of this workspace</p>
              <p className="text-aux text-muted-foreground">
                Full members only. Never guests or people from other workspaces.
              </p>
            </div>
            <Switch aria-label="Answer other members of this workspace" />
          </li>
        </ol>
      </section>
    </div>
  );
}

// ── Stand-ins for Slack's own screens ───────────────────────────────────────

function Placeholder({ label }: { label: string }) {
  return (
    <Badge variant="warning" className="self-center">
      Placeholder: {label}
    </Badge>
  );
}

function SlackApproveStandIn({ admin, go }: { admin: boolean; go: (next: Step) => void }) {
  return (
    <div className="flex min-h-dvh items-start justify-center bg-surface-muted px-4 py-12">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-8 border border-border bg-background p-6">
        <Placeholder label="Slack's approve screen" />
        <div className="flex items-center gap-3">
          <ConnectionBrandBadge connection="slack_app" />
          <p className="text-ui text-foreground">
            <strong>Rome</strong> is asking to join the <strong>{WORKSPACE}</strong> workspace
          </p>
        </div>
        <div className="space-y-2 text-ui text-foreground">
          <p className="text-aux text-muted-foreground">Rome will be able to</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Receive direct messages and mentions of it</li>
            <li>Read and send messages in channels it is added to</li>
            <li>See people's names in the workspace</li>
          </ul>
        </div>
        {admin ? (
          <p className="text-aux text-muted-foreground">
            {WORKSPACE} needs an admin to approve new apps.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => go("cancelled")}>
            Cancel
          </Button>
          {admin ? (
            <Button onClick={() => go("admin")}>Submit request</Button>
          ) : (
            <Button onClick={() => go("connected")}>Allow</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SlackHelloStill({ go }: { go: (next: Step) => void }) {
  return (
    <div className="flex min-h-dvh items-start justify-center bg-surface-muted px-4 py-12">
      <div className="flex w-full max-w-xl flex-col gap-4 rounded-8 border border-border bg-background p-6">
        <Placeholder label="a direct message in Slack" />
        <div className="border-b border-border pb-3 text-ui font-semibold text-foreground">
          Rome <span className="text-aux font-normal text-muted-foreground">App</span>
        </div>
        <div className="flex gap-3">
          <ConnectionBrandBadge connection="slack_app" />
          <div className="min-w-0 flex-1 space-y-2 text-ui text-foreground">
            <p>
              <strong>Rome</strong> <span className="text-aux text-muted-foreground">just now</span>
            </p>
            <p>Hi, I'm Rome.</p>
            <p>
              Message me here any time. To bring me into a channel, type /invite @rome there, then
              mention @rome when you want me.
            </p>
            <p>For now I answer only you. You can change that in Rome's settings.</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" className="self-start" onClick={() => go("connected")}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          Back to Rome
        </Button>
      </div>
    </div>
  );
}
