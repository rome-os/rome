import "./styles.css";
import { useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fetchAppApi, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { CircleAlert, LayoutTemplate, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Button } from "@rome-os/ui/button";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowIcon,
  FormRowLabel,
  FormRows,
} from "@rome-os/ui/layout-form";
import { ListCollection } from "@rome-os/ui/layout-list";
import {
  Measure,
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "@rome-os/ui/page";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rome-os/ui/select";
import { Spinner } from "@rome-os/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableRow } from "@rome-os/ui/table";

interface AppStatus {
  appId: string;
  version: string;
  status: string;
}

// Every query stays current without the guardian asking: it refetches on an
// interval while the page is visible and again when the tab regains focus. A
// failed refetch keeps the last good data, so the UI can show it with a warning.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

async function fetchStatus(): Promise<AppStatus> {
  const response = await fetchAppApi("status");
  if (!response.ok) {
    throw new Error(`Status request failed (${response.status})`);
  }
  return (await response.json()) as AppStatus;
}

export default function App({ bootstrap: _bootstrap }: { bootstrap: RomeAppBootstrap }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppPage />
    </QueryClientProvider>
  );
}

function AppPage() {
  const [defaultView, setDefaultView] = useState("overview");
  const { data: status, error: queryError } = useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
  });
  const error = queryError?.message ?? null;

  return (
    <Page className="min-h-full bg-[var(--app-canvas)]">
      <PageHeader>
        <PageHeading>
          <PageTitle>__APP_NAME__</PageTitle>
          <PageDescription>
            Starter UI for your new Rome app, built with the shared layout system.
          </PageDescription>
        </PageHeading>
        <PageActions>
          <Button variant="outline" asChild>
            <a href="https://www.npmjs.com/package/@rome-os/ui" target="_blank" rel="noreferrer">
              Component kit
            </a>
          </Button>
        </PageActions>
      </PageHeader>

      <Measure className="flex flex-col gap-6">
        <Section>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>Display</SectionTitle>
              <SectionDescription>Choose the view this app should open with.</SectionDescription>
            </SectionHeading>
          </SectionHeader>

          <FormRows>
            <FormRow>
              <FormRowIcon>
                <LayoutTemplate />
              </FormRowIcon>
              <FormRowHeading>
                <FormRowLabel htmlFor="default-view">Default view</FormRowLabel>
                <FormRowDescription>Controls the starting section of the app.</FormRowDescription>
              </FormRowHeading>
              <FormRowControl>
                <Select value={defaultView} onValueChange={setDefaultView}>
                  <SelectTrigger id="default-view" className="w-36">
                    <SelectValue placeholder="Choose a view" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="overview">Overview</SelectItem>
                    <SelectItem value="activity">Activity</SelectItem>
                    <SelectItem value="settings">Settings</SelectItem>
                  </SelectContent>
                </Select>
              </FormRowControl>
            </FormRow>
          </FormRows>
        </Section>

        <Section>
          <SectionHeader>
            <SectionHeading>
              <SectionTitle>App status</SectionTitle>
              <SectionDescription>
                Live read from <code>GET /api/apps/__APP_ID__/status</code>.
              </SectionDescription>
            </SectionHeading>
          </SectionHeader>

          {error && status ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>Updates are failing</AlertTitle>
              <AlertDescription>Showing the last loaded status. {error}</AlertDescription>
            </Alert>
          ) : null}

          {error && !status ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Status unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : status ? (
            <ListCollection className="rounded-12 border border-border bg-surface">
              <Table>
                <TableBody>
                  <TableRow>
                    <TableHead scope="row">App ID</TableHead>
                    <TableCell>{status.appId}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableHead scope="row">Version</TableHead>
                    <TableCell>{status.version}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableHead scope="row">Status</TableHead>
                    <TableCell>{status.status}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </ListCollection>
          ) : (
            <div className="flex min-h-24 items-center justify-center gap-2 rounded-12 border border-border bg-surface text-ui text-muted-foreground">
              <Spinner size="sm" label="Loading status" />
              Loading status…
            </div>
          )}
        </Section>
      </Measure>
    </Page>
  );
}
