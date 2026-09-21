import type { SessionModelIdentity } from "@rome/api-types/sessions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function modelIdentityLabel(model: SessionModelIdentity): string {
  if (model.kind === "unknown") return "Unknown model";
  return `${model.provider ?? "Unknown provider"} / ${model.name}`;
}

/** Compact list-cell treatment. Focus or tap the multi-model count to recover every identity. */
export function SessionModelSummary({
  models,
  inline = false,
}: {
  models: SessionModelIdentity[];
  inline?: boolean;
}) {
  if (models.length === 0) {
    return <span className="text-ui text-muted-foreground">No model recorded yet</span>;
  }

  const latest = models[0];
  if (!latest) return null;
  const summary = (
    <span className="flex min-w-0 items-start gap-2">
      <span className="min-w-0">
        <span className="block truncate text-ui text-foreground">
          {latest.kind === "known"
            ? inline
              ? modelIdentityLabel(latest)
              : latest.name
            : "Unknown model"}
        </span>
        {latest.kind === "known" && !inline ? (
          <span className="block truncate text-aux text-muted-foreground">
            {latest.provider ?? "Unknown provider"}
          </span>
        ) : null}
      </span>
      {models.length > 1 ? (
        <span className="mt-0.5 shrink-0 rounded-full bg-muted px-2 py-0.5 text-aux text-muted-foreground">
          +{models.length - 1}
        </span>
      ) : null}
    </span>
  );

  if (models.length === 1) return summary;

  const fullLabel = models.map(modelIdentityLabel).join(", ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span
          className="block min-w-0 cursor-pointer rounded-8 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          role="button"
          tabIndex={0}
          aria-label={`${models.length} models used: ${fullLabel}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
        >
          {summary}
        </span>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <p className="mb-2 text-ui font-medium">Models used</p>
        <div className="space-y-1 text-ui">
          {models.map((model, index) => (
            <p key={`${modelIdentityLabel(model)}-${index}`}>{modelIdentityLabel(model)}</p>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SessionModelList({ models }: { models: SessionModelIdentity[] }) {
  if (models.length === 0) {
    return <p className="mt-3 text-ui text-muted-foreground">No model has been recorded yet.</p>;
  }

  return (
    <ol className="mt-3 space-y-2 text-ui">
      {models.map((model, index) => (
        <li
          key={`${modelIdentityLabel(model)}-${index}`}
          className="rounded-8 border border-border-subtle bg-muted/30 px-3 py-2 text-foreground"
        >
          {modelIdentityLabel(model)}
        </li>
      ))}
    </ol>
  );
}
