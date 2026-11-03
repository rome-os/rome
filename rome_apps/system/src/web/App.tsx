import { navigateRome } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { UiScaleProvider } from "@rome-os/ui/ui-scale";
import "./styles.css";

// `rome build` needs a web entry, so System keeps this page. It stays off the
// launcher, and its spoken recaps settings live in Settings › Advanced.
export default function App() {
  return (
    <UiScaleProvider>
      <main className="min-h-screen bg-app-canvas px-4 py-6 font-sans text-foreground md:px-8 md:py-8">
        <div className="mx-auto max-w-3xl space-y-4">
          <h1 className="text-title">System</h1>
          <p className="text-ui text-muted-foreground">
            Spoken recaps settings have moved to Settings › Advanced.
          </p>
          <Button
            variant="outline"
            onClick={() => navigateRome({ path: "settings", tab: "advanced" })}
          >
            Open Settings
          </Button>
        </div>
      </main>
    </UiScaleProvider>
  );
}
