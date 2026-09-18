import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, Lock, Plus } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tile } from "@/components/ui/tile";
import {
  createSyncTarget,
  linkProject,
  listSyncGroups,
  listSyncSources,
  listSyncTargets,
  SyncApiError,
  type LinkStrategy,
  type RemoteTarget,
  type RemoteTargetCandidate,
  type SyncGroup,
  type SyncSourceInfo,
  type SyncStatus,
} from "@/lib/sync-api";
import { SourceIcon } from "./source-icon";

export type SourceConnectProps =
  | {
      mode: "link";
      projectPath: string;
      open: boolean;
      onClose: () => void;
      onLinked?: (status: SyncStatus) => void;
    }
  | {
      mode: "select";
      open: boolean;
      onClose: () => void;
      onResolved: (target: RemoteTarget, strategy: LinkStrategy) => void;
    };

type Step = "source" | "auth" | "target" | "strategy" | "working";

function repoName(fullName: string): string {
  const parts = fullName.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : fullName;
}

export function SourceConnect(props: SourceConnectProps) {
  const { open, onClose, mode } = props;

  const uid = useId();
  const [step, setStep] = useState<Step>("source");
  const [sources, setSources] = useState<SyncSourceInfo[]>([]);
  const [source, setSource] = useState<SyncSourceInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Target step
  const [groups, setGroups] = useState<SyncGroup[]>([]);
  const [group, setGroup] = useState<string>("");
  const [name, setName] = useState("");
  const [targets, setTargets] = useState<RemoteTargetCandidate[]>([]);
  const [isPrivate, setIsPrivate] = useState(true);
  const [creating, setCreating] = useState(false);

  // Conflict step
  const [conflictTarget, setConflictTarget] = useState<RemoteTarget | null>(null);

  const reset = useCallback(() => {
    setStep("source");
    setSource(null);
    setError(null);
    setGroups([]);
    setGroup("");
    setName("");
    setTargets([]);
    setIsPrivate(true);
    setCreating(false);
    setConflictTarget(null);
  }, []);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listSyncSources();
      setSources(list);
      if (list.length === 1) {
        const only = list[0];
        setSource(only);
        setStep(only.available ? "target" : "auth");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sources");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      reset();
      void loadSources();
    }
  }, [open, reset, loadSources]);

  const pickSource = useCallback((picked: SyncSourceInfo) => {
    setSource(picked);
    setError(null);
    setStep(picked.available ? "target" : "auth");
  }, []);

  // Load groups + existing targets when the target step opens.
  useEffect(() => {
    if (step !== "target" || !source) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      listSyncGroups(source.id).catch(() => [] as SyncGroup[]),
      listSyncTargets(source.id).catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load repositories");
        return [] as RemoteTargetCandidate[];
      }),
    ])
      .then(([groupList, targetList]) => {
        if (cancelled) return;
        // Merge API groups with any owner seen in the repo list, so every
        // existing repo is reachable by picking its owner.
        const merged = new Map<string, SyncGroup>();
        for (const g of groupList) merged.set(g.id, g);
        for (const t of targetList) {
          if (t.group && !merged.has(t.group)) merged.set(t.group, { id: t.group, label: t.group });
        }
        const groupValues = [...merged.values()];
        setGroups(groupValues);
        setGroup((prev) => prev || groupValues[0]?.id || "");
        setTargets(targetList);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, source]);

  // Existing repos in the selected group whose name matches the typed query.
  const trimmedName = name.trim();
  const matches = useMemo(() => {
    const q = trimmedName.toLowerCase();
    return targets
      .filter((t) => (group ? t.group === group : true))
      .filter((t) => !q || repoName(t.label).toLowerCase().includes(q));
  }, [targets, group, trimmedName]);

  const exactExists = useMemo(() => {
    const q = trimmedName.toLowerCase();
    if (!q) return false;
    return targets.some((t) => t.group === group && repoName(t.label).toLowerCase() === q);
  }, [targets, group, trimmedName]);
  const canOfferCreate = !loading && Boolean(trimmedName) && !exactExists;

  const finishLink = useCallback(
    async (target: RemoteTarget, strategy: LinkStrategy) => {
      if (mode === "select") {
        props.onResolved(target, strategy);
        onClose();
        return;
      }
      setStep("working");
      setError(null);
      try {
        const status = await linkProject({
          projectPath: props.projectPath,
          source: target.sourceId,
          target,
          strategy,
        });
        props.onLinked?.(status);
        onClose();
      } catch (err) {
        if (err instanceof SyncApiError && err.status === 409 && strategy === "auto") {
          setConflictTarget(target);
          setStep("strategy");
          setError(err.message);
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to connect");
        setStep("target");
      }
    },
    [mode, onClose, props],
  );

  const handleCreate = useCallback(async () => {
    if (!source || !trimmedName) return;
    setCreating(true);
    setError(null);
    try {
      const target = await createSyncTarget({
        source: source.id,
        group: group || undefined,
        name: trimmedName,
        private: isPrivate,
      });
      await finishLink(target, "auto");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the repository");
    } finally {
      setCreating(false);
    }
  }, [source, group, trimmedName, isPrivate, finishLink]);

  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Connect to a source" size="md">
      <DialogHeader onClose={onClose}>
        <div className="flex items-center gap-2">
          {source ? <SourceIcon source={source.id} className="size-4" /> : null}
          <DialogTitle>
            {mode === "select" ? "Connect this folder" : "Connect to a source"}
          </DialogTitle>
        </div>
      </DialogHeader>

      <DialogBody className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {step === "source" ? (
          <div className="space-y-2">
            <p className="text-ui text-muted-foreground">
              Choose where to keep this project in sync.
            </p>
            {loading ? (
              <Spinner label="Loading sync sources" className="text-muted-foreground" />
            ) : (
              sources.map((s) => (
                <Tile
                  key={s.id}
                  className="w-full"
                  icon={<SourceIcon source={s.id} className="size-5" />}
                  title={s.label}
                  description={s.available ? undefined : "Not connected"}
                  onClick={() => pickSource(s)}
                />
              ))
            )}
          </div>
        ) : null}

        {step === "auth" && source ? (
          <div className="space-y-3">
            <p className="text-ui text-muted-foreground">
              {source.reason ?? `${source.label} is not connected yet.`} Connect your account to
              continue.
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  if (source.connectUrl) window.location.href = source.connectUrl;
                }}
                disabled={!source.connectUrl}
              >
                <SourceIcon source={source.id} className="size-4" />
                Connect {source.label}
              </Button>
              <Button variant="outline" onClick={() => void loadSources()}>
                I&apos;ve connected — retry
              </Button>
            </div>
          </div>
        ) : null}

        {step === "target" && source ? (
          <div className="space-y-3">
            {/* Group first, then name (issue #2). */}
            <div className="space-y-2">
              <FieldLabel htmlFor={`${uid}-owner`}>Owner</FieldLabel>
              <Select value={group} onValueChange={setGroup}>
                <SelectTrigger id={`${uid}-owner`} className="w-full">
                  <SelectValue placeholder="Select an owner" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <FieldLabel htmlFor={`${uid}-repository`}>Repository</FieldLabel>
              <Command
                shouldFilter={false}
                loop
                label="Repository"
                className="h-auto bg-transparent"
              >
                <CommandInput
                  id={`${uid}-repository`}
                  autoFocus
                  value={name}
                  onValueChange={setName}
                  placeholder="Search or type a new name…"
                  className="border-border"
                />

                {loading ? (
                  <div className="flex items-center gap-2 px-1 py-3 text-ui text-subtle-foreground">
                    <Spinner label="Loading sync targets" /> <span aria-hidden>Loading…</span>
                  </div>
                ) : null}

                <CommandList label="Repositories" className="max-h-60">
                  {!loading && matches.length > 0 ? (
                    <CommandGroup>
                      {matches.map((target) => (
                        <CommandItem
                          key={target.label}
                          value={target.label}
                          onSelect={() => void finishLink(target, "auto")}
                          className="py-2"
                        >
                          <SourceIcon
                            source={source.id}
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate">{target.label}</span>
                          {target.isEmpty ? (
                            <span className="text-aux text-subtle-foreground">empty</span>
                          ) : null}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null}

                  {/* Keep this as a real option so free text remains a
                      keyboard-completable create path, not just a filter. */}
                  {canOfferCreate ? (
                    <CommandGroup className="mt-1 rounded-8 border border-dashed border-border">
                      <CommandItem
                        value={`create:${group}/${trimmedName}`}
                        onSelect={() => void handleCreate()}
                        disabled={creating || !group}
                        aria-label={creating ? "Creating sync target" : undefined}
                      >
                        {creating ? (
                          <Spinner label="Creating sync target" />
                        ) : (
                          <Plus className="size-4 shrink-0" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          Create{" "}
                          <span className="text-foreground">
                            {group}/{trimmedName}
                          </span>
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  ) : null}
                </CommandList>
              </Command>

              {/* A switch cannot be nested in a listbox option. Keep the
                  creation setting adjacent to the create option but outside
                  Command's ARIA tree and keyboard handling. */}
              {canOfferCreate ? (
                <label className="flex items-center justify-between px-2 text-aux text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Lock className="size-3" aria-hidden /> Private
                  </span>
                  <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
                </label>
              ) : null}
            </div>

            {!loading && matches.length === 0 && !trimmedName ? (
              <p className="px-1 py-3 text-center text-ui text-subtle-foreground">
                Start typing to search your repositories or create a new one.
              </p>
            ) : null}
          </div>
        ) : null}

        {step === "strategy" && conflictTarget ? (
          <div className="space-y-3">
            <p className="text-ui text-muted-foreground">
              Both this folder and <span className="text-foreground">{conflictTarget.label}</span>{" "}
              already have content. How should we reconcile them?
            </p>
            <div className="space-y-2">
              <Tile
                className="w-full"
                title="Keep the remote"
                description="Replace this folder with the remote. The files currently in this folder will be deleted."
                onClick={() => void finishLink(conflictTarget, "pull-remote")}
              />
              <Tile
                className="w-full"
                title="Keep this folder"
                description="Overwrite the remote with this folder's contents (force push)."
                onClick={() => void finishLink(conflictTarget, "push-local")}
              />
              <Tile
                className="w-full"
                title="Try to merge"
                description="Combine both. You may need to resolve conflicts afterward."
                onClick={() => void finishLink(conflictTarget, "merge")}
              />
            </div>
          </div>
        ) : null}

        {step === "working" ? (
          <div className="flex items-center gap-2 py-6 text-ui text-muted-foreground">
            <Spinner label="Connecting sync source" /> <span aria-hidden>Connecting…</span>
          </div>
        ) : null}
      </DialogBody>
    </Dialog>
  );
}
