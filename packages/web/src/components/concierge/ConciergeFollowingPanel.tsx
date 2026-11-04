import { BellRing, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  CONCIERGE_ALERT_DEFAULT_RULES,
  CONCIERGE_ALERT_MAX_SPACING_MINUTES,
  CONCIERGE_ALERT_MAX_TURNS_PER_HOUR,
  type ConciergeAlertRepoDto,
  type ConciergeAlertRules,
} from "@rome/api-types/concierge";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { Switch } from "@/components/ui/switch";
import { useConciergeFollowing } from "./use-concierge-following";

const DEFAULT_QUIET_HOURS = { start: "22:00", end: "08:00" };

/** The small grey heading over each part of the tab. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-3 pb-1 pt-4 text-aux text-muted-foreground">{children}</h3>;
}

function RepoSection({
  entry,
  onKind,
  onStop,
}: {
  entry: ConciergeAlertRepoDto;
  onKind: (kind: ConciergeAlertRepoDto["kinds"][number]["kind"], enabled: boolean) => void;
  onStop: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <section data-following-repo={entry.repo}>
      <div className="flex items-center gap-2 pl-3 pr-2 pb-1 pt-4">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-ui text-foreground">{entry.repo}</h3>
          {entry.login ? (
            <p className="truncate text-aux text-subtle-foreground">
              {t("concierge.following.asLogin", { login: entry.login })}
            </p>
          ) : null}
        </div>
        <IconButton
          size="xs"
          label={t("concierge.following.stopRepo", { repo: entry.repo })}
          icon={<X />}
          onClick={onStop}
          className="text-muted-foreground hover:text-foreground"
        />
      </div>
      <List asChild>
        <ul>
          {entry.kinds.map(({ kind, enabled }) => {
            const id = `following-${entry.repo}-${kind}`;
            return (
              <ListRow key={kind} asChild size="md">
                <li>
                  <ListRowContent>
                    <label htmlFor={id} className="block min-w-0">
                      <ListRowTitle className="truncate">
                        {t(`concierge.following.kinds.${kind}`)}
                      </ListRowTitle>
                    </label>
                  </ListRowContent>
                  <Switch
                    id={id}
                    size="sm"
                    checked={enabled}
                    onCheckedChange={(checked) => onKind(kind, checked)}
                  />
                </li>
              </ListRow>
            );
          })}
        </ul>
      </List>
    </section>
  );
}

/** A whole-number field that saves when it loses focus, within its bounds. */
function NumberField({
  id,
  value,
  min,
  max,
  onSave,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onSave(parsed);
  };
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      size="sm"
      min={min}
      max={max}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className="w-20 shrink-0 tabular-nums"
    />
  );
}

function RulesSection({
  rules,
  onChange,
}: {
  rules: ConciergeAlertRules;
  onChange: (change: Partial<ConciergeAlertRules>) => void;
}) {
  const { t } = useTranslation("chat");
  const quiet = rules.quietHours;
  const setQuietTime = (field: "start" | "end", value: string) => {
    if (!quiet || !/^\d{2}:\d{2}$/.test(value) || value === quiet[field]) return;
    const next = { ...quiet, [field]: value };
    if (next.start !== next.end) onChange({ quietHours: next });
  };
  return (
    <section>
      <SectionHeading>{t("concierge.following.rules")}</SectionHeading>
      <List asChild>
        <ul>
          <ListRow asChild size="md">
            <li>
              <ListRowContent>
                <label htmlFor="following-max-turns">
                  <ListRowTitle>{t("concierge.following.maxTurnsPerHour")}</ListRowTitle>
                </label>
              </ListRowContent>
              <NumberField
                id="following-max-turns"
                value={rules.maxTurnsPerHour}
                min={1}
                max={CONCIERGE_ALERT_MAX_TURNS_PER_HOUR}
                onSave={(maxTurnsPerHour) => onChange({ maxTurnsPerHour })}
              />
            </li>
          </ListRow>
          <ListRow asChild size="md">
            <li>
              <ListRowContent>
                <label htmlFor="following-min-spacing">
                  <ListRowTitle>{t("concierge.following.minSpacingMinutes")}</ListRowTitle>
                </label>
              </ListRowContent>
              <NumberField
                id="following-min-spacing"
                value={rules.minSpacingMinutes}
                min={0}
                max={CONCIERGE_ALERT_MAX_SPACING_MINUTES}
                onSave={(minSpacingMinutes) => onChange({ minSpacingMinutes })}
              />
            </li>
          </ListRow>
          <ListRow asChild size="md">
            <li>
              <ListRowContent>
                <label htmlFor="following-quiet-hours">
                  <ListRowTitle>{t("concierge.following.quietHours")}</ListRowTitle>
                </label>
                <ListRowDescription>{t("concierge.following.quietHoursHint")}</ListRowDescription>
              </ListRowContent>
              <Switch
                id="following-quiet-hours"
                size="sm"
                checked={quiet !== null}
                onCheckedChange={(checked) =>
                  onChange({ quietHours: checked ? DEFAULT_QUIET_HOURS : null })
                }
              />
            </li>
          </ListRow>
          {quiet ? (
            <ListRow asChild size="md">
              <li className="flex-wrap">
                <label className="flex items-center gap-2 text-ui text-muted-foreground">
                  {t("concierge.following.quietStart")}
                  <Input
                    type="time"
                    size="sm"
                    defaultValue={quiet.start}
                    key={`start-${quiet.start}`}
                    onBlur={(event) => setQuietTime("start", event.target.value)}
                    className="w-36 tabular-nums"
                  />
                </label>
                <label className="flex items-center gap-2 text-ui text-muted-foreground">
                  {t("concierge.following.quietEnd")}
                  <Input
                    type="time"
                    size="sm"
                    defaultValue={quiet.end}
                    key={`end-${quiet.end}`}
                    onBlur={(event) => setQuietTime("end", event.target.value)}
                    className="w-36 tabular-nums"
                  />
                </label>
              </li>
            </ListRow>
          ) : null}
        </ul>
      </List>
    </section>
  );
}

/**
 * What the Concierge follows for the guardian: the GitHub repos, each event
 * kind on or off, and the rules that bound how often their events wake it.
 * The Concierge starts following a repo from chat; this panel tunes it.
 */
export function ConciergeFollowingPanel() {
  const { t } = useTranslation("chat");
  const { data, loaded, setKind, stopRepo, setRules } = useConciergeFollowing();
  if (!loaded) return null;
  const repos = data?.repos ?? [];
  const rules = data?.rules ?? CONCIERGE_ALERT_DEFAULT_RULES;
  const failed = () => toast.error(t("concierge.following.saveFailed"));
  return (
    <div className="flex h-full flex-col overflow-y-auto pb-safe">
      {repos.length === 0 ? (
        <EmptyState className="py-8">
          <EmptyStateIcon>
            <BellRing />
          </EmptyStateIcon>
          <EmptyStateTitle>{t("concierge.following.emptyTitle")}</EmptyStateTitle>
          <EmptyStateDescription>{t("concierge.following.emptyDescription")}</EmptyStateDescription>
        </EmptyState>
      ) : (
        repos.map((entry) => (
          <RepoSection
            key={entry.repo}
            entry={entry}
            onKind={(kind, enabled) =>
              setKind.mutate({ repo: entry.repo, kind, enabled }, { onError: failed })
            }
            onStop={() =>
              stopRepo.mutate(entry.repo, {
                onSuccess: () =>
                  toast.success(t("concierge.following.stopped", { repo: entry.repo })),
                onError: failed,
              })
            }
          />
        ))
      )}
      <RulesSection
        rules={rules}
        onChange={(change) => setRules.mutate(change, { onError: failed })}
      />
    </div>
  );
}
