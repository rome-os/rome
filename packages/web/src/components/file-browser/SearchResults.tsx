import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";

export function SearchResults({ onMobileBack }: { onMobileBack: () => void }) {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const searchQuery = useFileBrowserStore((s) => s.ui.searchQuery);
  const searchResults = useFileBrowserStore((s) => s.ui.searchResults);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <IconButton
            onClick={onMobileBack}
            label={t("header.backToFiles")}
            icon={<ArrowLeft aria-hidden />}
            className="text-muted-foreground hover:bg-surface-muted hover:text-foreground @min-[1024px]/fb:hidden"
          />
          <h2 className="min-w-0 text-section text-foreground">
            <span className="truncate">{t("search.headingFor", { query: searchQuery })}</span>
            <span className="ml-2 text-aux text-subtle-foreground">
              {t("search.matches", { count: searchResults.length })}
            </span>
          </h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => store.getState().ui.setShowSearch(false)}
          className="text-muted-foreground"
        >
          {t("search.close")}
        </Button>
      </div>
      {searchResults.length === 0 ? (
        <p className="text-ui text-muted-foreground">{t("search.noResults")}</p>
      ) : (
        <div className="space-y-2">
          {searchResults.map((result, index) => (
            <button
              key={`${result.file}:${result.line}:${index}`}
              onClick={() => store.getState().selection.guardedSelectFile(result.file)}
              className="block w-full rounded-8 border border-border bg-surface p-3 text-left hover:border-info-border hover:bg-info-bg"
            >
              <div className="mb-1 break-all text-aux text-info-fg">
                {result.file}:{result.line}
              </div>
              <div className="line-clamp-2 text-ui text-foreground">{result.content}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
