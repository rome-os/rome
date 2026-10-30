import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isChunkLoadError } from "@/lib/lazy-with-reload";

function ChunkErrorScreen() {
  const { t } = useTranslation("common");
  return (
    <main role="alert" className="flex min-h-0 flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <h1 className="mb-2 text-title text-foreground">{t("chunkError.title")}</h1>
        <p className="mb-6 text-ui text-muted-foreground">{t("chunkError.description")}</p>
        <Button onClick={() => window.location.reload()}>{t("chunkError.reload")}</Button>
      </div>
    </main>
  );
}

interface State {
  error: Error | null;
}

/**
 * Shows a reload screen when a lazy chunk fails to load. Any other error passes
 * through to the next boundary, so this never hides a real render bug.
 */
export class ChunkErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (!isChunkLoadError(error)) throw error;
    return <ChunkErrorScreen />;
  }
}
