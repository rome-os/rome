import { BellRing, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  CONCIERGE_FOLLOW_DEFAULT_RULES,
  CONCIERGE_FOLLOW_MAX_SPACING_MINUTES,
  CONCIERGE_FOLLOW_MAX_TURNS_PER_HOUR,
  CONCIERGE_FOLLOW_PREFERENCE_MAX_LENGTH,
  type ConciergeFollowChange,
  type ConciergeFollowDto,
  type ConciergeFollowKindDto,
  type ConciergeFollowOptionDto,
  type ConciergeFollowRules,
  type ConciergeFollowSourceDto,
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConciergeFollowing } from "./use-concierge-following";

const DEFAULT_QUIET_HOURS = { start: "22:00", end: "08:00" };

/** The small grey heading over each part of the tab. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-3 pb-1 pt-4 text-aux text-muted-foreground">{children}</h3>;
}

/** A list option, edited as comma-separated text and saved when it loses focus. */
function ListField({
  id,
  value,
  placeholder,
  onSave,
}: {
  id: string;
  value: string[];
  placeholder?: string;
  onSave: (value: string[]) => void;
}) {
  const joined = value.join(", ");
  const [draft, setDraft] = useState(joined);
  useEffect(() => setDraft(joined), [joined]);
  const commit = () => {
    const next = [
      ...new Set(
        draft
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    if (next.join(", ") !== joined) onSave(next);
  };
  return (
    <Input
      id={id}
      size="sm"
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className="w-full"
    />
  );
}

/** The guardian's own words for a follow, saved when the field loses focus. */
function PreferenceField({
  id,
  value,
  onSave,
}: {
  id: string;
  value: string | null;
  onSave: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <Textarea
      id={id}
      value={draft}
      rows={2}
      maxLength={CONCIERGE_FOLLOW_PREFERENCE_MAX_LENGTH}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft.trim() || null;
        if (next !== (value ?? null)) onSave(next);
      }}
      className="w-full"
    />
  );
}

/** Whether a kind applies under the follow's current options. */
const applies = (kind: ConciergeFollowKindDto, follow: ConciergeFollowDto) =>
  !kind.requires || follow.options[kind.requires.option] === kind.requires.value;

function FollowSection({
  source,
  follow,
  onChange,
  onStop,
}: {
  source: ConciergeFollowSourceDto;
  follow: ConciergeFollowDto;
  onChange: (change: Omit<ConciergeFollowChange, "source" | "target">) => void;
  onStop: () => void;
}) {
  const { t } = useTranslation("chat");
  const base = `following-${source.source}-${follow.target}`;
  const kindLabel = (kind: ConciergeFollowKindDto) =>
    t(`concierge.following.kinds.${source.source}.${kind.kind}`, { defaultValue: kind.label });
  const optionLabel = (option: ConciergeFollowOptionDto) =>
    t(`concierge.following.options.${source.source}.${option.key}.label`, {
      defaultValue: option.label,
    });
  const on = new Set(follow.kinds.filter((k) => k.on).map((k) => k.kind));
  return (
    <section data-following-item={`${source.source}:${follow.target}`}>
      <div className="flex items-center gap-2 pl-3 pr-2 pb-1 pt-3">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-ui text-foreground">{follow.target}</h4>
          {follow.state !== "active" ? (
            <p className="truncate text-aux text-subtle-foreground">
              {t(`concierge.following.state.${follow.state}`)}
            </p>
          ) : null}
        </div>
        <IconButton
          size="xs"
          label={t("concierge.following.stopItem", { target: follow.target })}
          icon={<X />}
          onClick={onStop}
          className="text-muted-foreground hover:text-foreground"
        />
      </div>
      <List asChild>
        <ul>
          {source.kinds
            .filter((kind) => applies(kind, follow))
            .map((kind) => {
              const id = `${base}-kind-${kind.kind}`;
              return (
                <ListRow key={kind.kind} asChild size="md">
                  <li>
                    <ListRowContent>
                      <label htmlFor={id} className="block min-w-0">
                        <ListRowTitle className="truncate">{kindLabel(kind)}</ListRowTitle>
                      </label>
                    </ListRowContent>
                    <Switch
                      id={id}
                      size="sm"
                      checked={on.has(kind.kind)}
                      onCheckedChange={(checked) => onChange({ kinds: { [kind.kind]: checked } })}
                    />
                  </li>
                </ListRow>
              );
            })}
          {source.options.map((option) => {
            const id = `${base}-option-${option.key}`;
            const value = follow.options[option.key];
            if (option.type === "boolean") {
              return (
                <ListRow key={option.key} asChild size="md">
                  <li>
                    <ListRowContent>
                      <label htmlFor={id} className="block min-w-0">
                        <ListRowTitle className="truncate">{optionLabel(option)}</ListRowTitle>
                      </label>
                    </ListRowContent>
                    <Switch
                      id={id}
                      size="sm"
                      checked={value === true}
                      onCheckedChange={(checked) =>
                        onChange({ options: { [option.key]: checked } })
                      }
                    />
                  </li>
                </ListRow>
              );
            }
            if (option.type === "enum") {
              return (
                <ListRow key={option.key} asChild size="md">
                  <li className="flex-wrap">
                    <ListRowContent>
                      <ListRowTitle className="truncate">{optionLabel(option)}</ListRowTitle>
                    </ListRowContent>
                    <SegmentedControl
                      size="sm"
                      aria-label={optionLabel(option)}
                      value={String(value ?? option.default)}
                      onValueChange={(next) => onChange({ options: { [option.key]: next } })}
                      options={(option.values ?? []).map((v) => ({
                        value: v.value,
                        label: t(
                          `concierge.following.options.${source.source}.${option.key}.${v.value}`,
                          { defaultValue: v.label },
                        ),
                      }))}
                    />
                  </li>
                </ListRow>
              );
            }
            return (
              <ListRow key={option.key} asChild size="md">
                <li className="flex-col items-stretch gap-1">
                  <label htmlFor={id} className="block min-w-0">
                    <ListRowTitle className="truncate">{optionLabel(option)}</ListRowTitle>
                  </label>
                  <ListField
                    id={id}
                    value={Array.isArray(value) ? value : []}
                    placeholder={option.itemHint}
                    onSave={(next) => onChange({ options: { [option.key]: next } })}
                  />
                </li>
              </ListRow>
            );
          })}
          <ListRow asChild size="md">
            <li className="flex-col items-stretch gap-1">
              <label htmlFor={`${base}-preference`} className="block min-w-0">
                <ListRowTitle>{t("concierge.following.preference")}</ListRowTitle>
                <ListRowDescription>{t("concierge.following.preferenceHint")}</ListRowDescription>
              </label>
              <PreferenceField
                id={`${base}-preference`}
                value={follow.preference}
                onSave={(preference) => onChange({ preference })}
              />
            </li>
          </ListRow>
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
  rules: ConciergeFollowRules;
  onChange: (change: Partial<ConciergeFollowRules>) => void;
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
                max={CONCIERGE_FOLLOW_MAX_TURNS_PER_HOUR}
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
                max={CONCIERGE_FOLLOW_MAX_SPACING_MINUTES}
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
 * What the Concierge follows for the guardian, grouped by source, from the
 * same structure the Concierge reads: each follow's kinds, options and
 * preference, what else the guardian's connections let it follow (and why not,
 * when they cannot), and the rules shared by every source. The Concierge starts
 * a follow from chat; this panel tunes it.
 */
export function ConciergeFollowingPanel() {
  const { t } = useTranslation("chat");
  const { data, loaded, followCount, configure, unfollow, setRules } = useConciergeFollowing();
  if (!loaded) return null;
  const sources = data?.sources ?? [];
  const rules = data?.rules ?? CONCIERGE_FOLLOW_DEFAULT_RULES;
  const failed = () => toast.error(t("concierge.following.saveFailed"));
  const followed = sources.filter((source) => (source.follows?.length ?? 0) > 0);
  const offered = sources.filter((source) => (source.follows?.length ?? 0) === 0);
  return (
    <div className="flex h-full flex-col overflow-y-auto pb-safe">
      {followCount === 0 ? (
        <EmptyState className="py-8">
          <EmptyStateIcon>
            <BellRing />
          </EmptyStateIcon>
          <EmptyStateTitle>{t("concierge.following.emptyTitle")}</EmptyStateTitle>
          <EmptyStateDescription>{t("concierge.following.emptyDescription")}</EmptyStateDescription>
        </EmptyState>
      ) : (
        followed.map((source) => (
          <section key={source.source} data-following-source={source.source}>
            <SectionHeading>
              {source.account
                ? t("concierge.following.sourceWithAccount", {
                    source: source.label,
                    account: source.account,
                  })
                : source.label}
            </SectionHeading>
            {source.status !== "ready" && source.statusReason ? (
              <p className="px-3 pb-1 text-aux text-warning-fg">{source.statusReason}</p>
            ) : null}
            {source.follows.map((follow) => (
              <FollowSection
                key={follow.target}
                source={source}
                follow={follow}
                onChange={(change) =>
                  configure.mutate(
                    { source: source.source, target: follow.target, ...change },
                    { onError: failed },
                  )
                }
                onStop={() =>
                  unfollow.mutate(
                    { source: source.source, target: follow.target },
                    {
                      onSuccess: () =>
                        toast.success(t("concierge.following.stopped", { target: follow.target })),
                      onError: failed,
                    },
                  )
                }
              />
            ))}
          </section>
        ))
      )}
      {offered.length > 0 ? (
        <section data-following-offered>
          <SectionHeading>{t("concierge.following.alsoFollow")}</SectionHeading>
          <List asChild>
            <ul>
              {offered.map((source) => (
                <ListRow key={source.source} asChild size="md">
                  <li>
                    <ListRowContent>
                      <ListRowTitle className="truncate">{source.label}</ListRowTitle>
                      <ListRowDescription>
                        {source.status === "ready"
                          ? t("concierge.following.readyHint", {
                              kinds: source.kinds
                                .filter((kind) => kind.default)
                                .map((kind) =>
                                  t(`concierge.following.kinds.${source.source}.${kind.kind}`, {
                                    defaultValue: kind.label,
                                  }),
                                )
                                .join(" · "),
                            })
                          : (source.statusReason ??
                            t(`concierge.following.status.${source.status}`))}
                      </ListRowDescription>
                    </ListRowContent>
                  </li>
                </ListRow>
              ))}
            </ul>
          </List>
        </section>
      ) : null}
      <RulesSection
        rules={rules}
        onChange={(change) => setRules.mutate(change, { onError: failed })}
      />
    </div>
  );
}
