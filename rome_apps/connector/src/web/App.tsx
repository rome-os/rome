import { navigateRome } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { UiScaleProvider } from "@rome-os/ui/ui-scale";
import "./styles.css";
// Side-effect imports: each top-level defineComponent() registers an inline
// card into this bundle's SDK registry, so the host can mount it in the chat.
// "connect-card" is what connector_connect renders, for both Rome-managed and
// Composio toolkits; "login-card" is the Composio sign-in connector_login
// renders when no key is saved.
import "@/connect-card";
import "@/login-card";

// `rome build` needs a web entry, and the cards above ride in its bundle, so
// Connector keeps this page. It stays off the launcher: its services are
// managed in Settings › Connections.
export default function App() {
  return (
    <UiScaleProvider>
      <main className="min-h-screen bg-app-canvas px-4 py-6 font-sans text-foreground md:px-8 md:py-8">
        <div className="mx-auto max-w-3xl space-y-4">
          <h1 className="text-title">Connector</h1>
          <p className="text-ui text-muted-foreground">
            Connections have moved to Settings › Connections.
          </p>
          <Button
            variant="outline"
            onClick={() => navigateRome({ path: "settings", tab: "connections" })}
          >
            Open Settings
          </Button>
        </div>
      </main>
    </UiScaleProvider>
  );
}
