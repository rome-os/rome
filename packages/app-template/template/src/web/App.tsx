import "./styles.css";
import { useEffect, useState } from "react";
import { fetchAppApi, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { RefreshCw, Sparkles } from "lucide-react";
// Primitives are imported from the published component kit, never copied into
// this tree: `pnpm up @rome-os/ui` is the whole upgrade path for fixes and new
// components. Copy a shadcn recipe into `components/ui/` only for a primitive
// the kit does not publish.
import { Button } from "@rome-os/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@rome-os/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rome-os/ui/select";

interface AppStatus {
  appId: string;
  version: string;
  status: string;
}

export default function App({ bootstrap: _bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [defaultView, setDefaultView] = useState("overview");

  async function loadStatus(): Promise<void> {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetchAppApi("");
      // Query params are supported, e.g. fetchAppApi("repos?limit=50")
      const data = (await response.json()) as AppStatus;
      setStatus(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  return (
    <main className="min-h-full bg-[var(--app-canvas)] px-6 py-12">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center gap-3">
          <Sparkles className="text-primary" />
          <h1 className="text-3xl font-semibold tracking-tight">__APP_NAME__</h1>
        </div>
        <p className="mt-2 text-muted-foreground">
          Starter UI for your new Rome app. Tailwind v4 and the Rome component kit are wired up —
          replace this screen with something useful.
        </p>
        {/* Visitor-facing app (public link + Rome Cloud sign-in)? One line adds
          the whole identity control — the signed-in user's avatar icon, the
          owner icon, or a sign-in button — sized for the top-right corner of
          the header row above; the server-side counterpart is
          `requireVisitor(request)` in src/api/index.ts:

          import { CallerBadge } from "@rome-os/app-web-sdk";
          <CallerBadge className="ml-auto" />
      */}

        <Card className="mt-8">
          <CardHeader>
            <CardTitle>App status</CardTitle>
            <CardDescription>
              Live read from <code>GET /api/apps/__APP_ID__/</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-6 grid gap-2 sm:max-w-xs">
              <label className="text-sm font-medium" htmlFor="default-view">
                Default view
              </label>
              <Select value={defaultView} onValueChange={setDefaultView}>
                {/* Kit controls size to their content; widen from the call site. */}
                <SelectTrigger id="default-view" className="w-full">
                  <SelectValue placeholder="Choose a view" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="overview">Overview</SelectItem>
                  <SelectItem value="activity">Activity</SelectItem>
                  <SelectItem value="settings">Settings</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {error}
              </div>
            ) : status ? (
              <pre className="overflow-x-auto rounded-md border bg-muted p-4 text-sm">
                {JSON.stringify(status, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">Loading status…</p>
            )}
          </CardContent>
          <CardFooter className="gap-2">
            <Button onClick={() => void loadStatus()} disabled={refreshing}>
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            <Button variant="outline" asChild>
              <a href="https://www.npmjs.com/package/@rome-os/ui" target="_blank" rel="noreferrer">
                Component kit
              </a>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
