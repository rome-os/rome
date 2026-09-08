import { useState, useEffect, useId, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useForm } from "@tanstack/react-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { z } from "zod";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroupLabel, FieldLabel } from "@/components/ui/field";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tile } from "@/components/ui/tile";
import {
  AlertTriangle,
  AlignLeft,
  Calendar as CalendarIcon,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Filter,
  List as ListIcon,
  MoreHorizontal,
  Play,
  Plus,
  Radio,
  Search,
  Square,
} from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { artifactLocalName } from "@/lib/artifact-name";
import { PageShell, PageBody } from "@/shell/PageShell";
import { describeTrigger, describeOutcome, relativeTime } from "@/lib/routine-language";
import { useActionCatalog, type ActionCatalogEntry } from "@/hooks/use-action-catalog";
import { buildArgsTemplate, describeArgType, evaluateArgsText } from "@/lib/action-args";
import {
  useRoutines,
  useInvalidateRoutines,
  useRunRoutineNow,
  useStopRoutine,
} from "@/hooks/use-routines";

interface ScheduleTrigger {
  type: "schedule";
  tzid: string;
  // Floating follows the guardian's timezone; fixed pins `tzid`.
  tzMode: "fixed" | "floating";
  localTime: string;
  date?: string;
  rrule?: string;
}

interface EventBusTrigger {
  type: "event-bus";
  eventName: string;
  sourcePattern?: string;
}

// A routine that never fires on its own — it only runs via "Run now". Carries
// no config of its own.
interface ManualTrigger {
  type: "manual";
}

type Trigger = ScheduleTrigger | EventBusTrigger | ManualTrigger;
type TriggerType = Trigger["type"];

type RunStatus = "success" | "error" | "running" | "pending_approval" | "cancelled";

interface Routine {
  id: string;
  name: string;
  // The app that owns this routine, if any. A managed routine can't be deleted
  // from the dashboard (the server refuses too) — only the owning app removes it.
  managedBy?: string | null;
  enabled: boolean;
  trigger: Trigger;
  actionName: string;
  args: Record<string, unknown>;
  createdAt: string;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  lastRun?: { status: RunStatus; firedAt: string } | null;
}

type ViewMode = "timeline" | "calendar" | "table";
type TableFilter = "all" | "active" | "disabled" | "schedule" | "event-bus" | "manual" | "failing";

// A routine is "failing" when its most recent run errored.
function isFailing(r: Routine): boolean {
  return r.lastRun?.status === "error";
}

function formatDateTime(t: TFunction, dateStr: string | null): string {
  const missing = t("datetime.missing");
  if (!dateStr) return missing;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return missing;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isPast(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return new Date(dateStr).getTime() < Date.now();
}

function isSchedule(r: Routine): r is Routine & { trigger: ScheduleTrigger } {
  return r.trigger.type === "schedule";
}

function isEventBus(r: Routine): r is Routine & { trigger: EventBusTrigger } {
  return r.trigger.type === "event-bus";
}

function isManual(r: Routine): r is Routine & { trigger: ManualTrigger } {
  return r.trigger.type === "manual";
}

// A one-off task is done once its schedule consumed it: the trigger fired
// (lastFiredAt is only ever set by a real trigger fire, never by "Run now") and
// the run reached a terminal state — a still-running or approval-pending run
// keeps the card in the live section. Recurring schedules never complete.
function isCompletedOneOff(r: Routine): boolean {
  if (!isSchedule(r) || r.trigger.rrule) return false;
  if (!r.lastFiredAt) return false;
  const status = r.lastRun?.status;
  return status !== "running" && status !== "pending_approval";
}

function scheduleSubtypeLabel(t: TFunction, trigger: ScheduleTrigger): string {
  return trigger.rrule ? t("schedule.subtypeRecurring") : t("schedule.subtypeOneOff");
}
// The human-facing name for a routine, used wherever a routine is named (rows,
// stats, next-up). The guardian-written name headlines the routine; agent-created
// routines often carry a machine name equal to the action (no real name to show),
// so the humanized action phrase stands in. Never surfaces the snake_case id.
function routineDisplayName(routine: Routine): string {
  const trimmedName = routine.name.trim();
  if (
    trimmedName !== "" &&
    trimmedName !== routine.actionName &&
    trimmedName !== artifactLocalName(routine.actionName)
  ) {
    return trimmedName;
  }
  const outcomePhrase = describeOutcome(routine.actionName, routine.args);
  return outcomePhrase.charAt(0).toUpperCase() + outcomePhrase.slice(1);
}

// Adapts shadcn's Popover + Calendar recipe to our string-shaped form state.
// The form stores `YYYY-MM-DD` (Zod string + RRULE expect it); Calendar speaks
// Date. Parse/format here so the rest of the form stays unchanged. We avoid
// `new Date("YYYY-MM-DD")` (which parses as UTC midnight and can shift the day
// in negative TZs) by constructing from local components.

function parseLocalDateString(value: string): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? undefined : d;
}

function DatePickerInput({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const date = parseLocalDateString(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          id={id}
          onBlur={onBlur}
          aria-invalid={invalid || undefined}
          className="w-full justify-between"
        >
          <span className={date ? "" : "text-muted-foreground"}>
            {date ? format(date, "PPP") : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          captionLayout="dropdown"
          defaultMonth={date}
          onSelect={(d) => {
            onChange(d ? format(d, "yyyy-MM-dd") : "");
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const TRIGGER_BADGE_VARIANT: Record<TriggerType, "brand" | "info" | "muted"> = {
  schedule: "brand",
  "event-bus": "info",
  manual: "muted",
};

function TriggerBadge({
  trigger,
  showSubtype = true,
}: {
  trigger: Trigger;
  showSubtype?: boolean;
}) {
  const { t } = useTranslation("routines");
  const icon =
    trigger.type === "schedule" ? (
      <Clock aria-hidden />
    ) : trigger.type === "manual" ? (
      <Play aria-hidden />
    ) : (
      <Radio aria-hidden />
    );
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={TRIGGER_BADGE_VARIANT[trigger.type]}>
        {icon}
        {t(`trigger.${trigger.type}`)}
      </Badge>
      {showSubtype && trigger.type === "schedule" && (
        <span className="text-aux text-muted-foreground">· {scheduleSubtypeLabel(t, trigger)}</span>
      )}
    </span>
  );
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function isSameDay(d1: Date, d2: Date): boolean {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

// Re-render on a coarse minute-ish tick so relative times ("in 12 min") in the
// panel stay fresh without a per-second counter.
function useMinuteTick() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
}

// A single vertical stat cell: a small muted label over a larger number.
function StatCell({
  label,
  value,
  valueClassName = "text-foreground",
}: {
  label: string;
  value: number;
  valueClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-aux text-muted-foreground">{label}</div>
      <div className={`text-title tabular-nums ${valueClassName}`}>{value}</div>
    </div>
  );
}

// "Next up" — the soonest future run. The name uses the same display-name
// derivation as the list rows, and the ETA is formatted by date-fns ("in 31
// minutes" / "in 2 hours"), matching the relative time the rows show.
function NextUpBlock({ routine }: { routine: Routine | undefined }) {
  const { t } = useTranslation("routines");
  useMinuteTick();

  const target = routine?.nextRunAt ? new Date(routine.nextRunAt) : null;
  const hasNext = !!routine && !!target && !Number.isNaN(target.getTime());
  const overdue = hasNext && target!.getTime() <= Date.now();
  const rel = !hasNext
    ? null
    : overdue
      ? t("stats.etaOverdue")
      : formatDistanceToNowStrict(target!, { addSuffix: true });

  return (
    <div className="flex min-w-0 flex-col justify-center gap-2 px-5 py-4 sm:px-6 sm:py-5">
      <div className="flex items-center gap-1 text-aux text-muted-foreground">
        <Clock className="size-3.5 flex-shrink-0" aria-hidden />
        {t("stats.nextUp")}
      </div>
      {hasNext ? (
        <div className="truncate text-ui text-foreground">
          {routineDisplayName(routine!)}
          <span className="text-muted-foreground"> — {rel}</span>
        </div>
      ) : (
        <div className="text-ui text-subtle-foreground">{t("stats.noUpcoming")}</div>
      )}
    </div>
  );
}

function StatsBar({ routines }: { routines: Routine[] }) {
  const { t } = useTranslation("routines");
  const active = routines.filter((r) => r.enabled).length;
  const paused = routines.filter((r) => !r.enabled).length;
  const nextRoutine = routines
    .filter((r) => r.enabled && r.nextRunAt && !isPast(r.nextRunAt))
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime())[0];

  // Health (failing vs. healthy) is intentionally NOT shown here — it lives as a
  // red pill beside the page title, and only when something is actually wrong.
  return (
    <div className="flex flex-col overflow-hidden rounded-12 border border-border bg-surface sm:flex-row sm:items-stretch">
      {/* Stat cells — generously spaced, each label-over-number. */}
      <div className="flex flex-wrap items-center gap-6 px-5 py-4 sm:flex-1 sm:flex-nowrap sm:gap-10 sm:px-6 sm:py-5">
        <StatCell label={t("stats.total")} value={routines.length} />
        <StatCell label={t("stats.active")} value={active} />
        <StatCell label={t("stats.paused")} value={paused} valueClassName="text-muted-foreground" />
      </div>

      {/* Thin divider, then the next-up block. */}
      <div className="h-px w-full bg-border sm:h-auto sm:w-px" />
      <NextUpBlock routine={nextRoutine} />
    </div>
  );
}

// The health pill that sits beside the page title — shown ONLY when one or more
// routines are failing. A confirmed-healthy state shows nothing at all, so good
// days carry no badge. Clicking it jumps to the failing-filtered list.
function HealthPill({ failing, onShowFailing }: { failing: number; onShowFailing: () => void }) {
  const { t } = useTranslation("routines");
  if (failing === 0) return null;
  return (
    <Button
      type="button"
      variant="destructive"
      // `md`, not `sm`: the pill sits beside the page's `text-title` h1, whose
      // 24px line box would leave a 28px control reading as an afterthought.
      size="md"
      shape="pill"
      onClick={onShowFailing}
      aria-label={t("stats.failingAria", { n: failing })}
      className="group"
    >
      <AlertTriangle data-icon="inline-start" aria-hidden />
      <span className="tabular-nums">{t("stats.failingCount", { n: failing })}</span>
      <ChevronRight
        data-icon="inline-end"
        className="transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Button>
  );
}

function TimelineView({
  routines,
  onToggle,
  onDelete,
}: {
  routines: Routine[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation("routines");
  const scheduleOnly = routines.filter(isSchedule);
  const sorted = [...scheduleOnly].sort((a, b) => {
    const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity;
    const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity;
    return aTime - bTime;
  });

  const now = Date.now();
  const nowIndex = sorted.findIndex((r) => r.nextRunAt && new Date(r.nextRunAt).getTime() > now);

  return (
    <div className="relative mx-auto max-w-2xl py-4">
      {/* Timeline rail: a 2px border on a zero-width element, not a sized
          box, so it authors no off-scale edge length. */}
      <div className="absolute bottom-0 left-3 top-0 border-l-2 border-border sm:left-6" />

      {sorted.map((routine, i) => {
        const past = isPast(routine.nextRunAt);
        const showNowLine = nowIndex === i;
        const trigger = routine.trigger as ScheduleTrigger;
        const recurring = !!trigger.rrule;

        return (
          <div key={routine.id}>
            {showNowLine && (
              <div className="relative mb-4 flex items-center py-2">
                <div className="absolute left-1 h-3 w-3 rounded-full border-2 border-destructive bg-destructive ring-2 ring-destructive-border z-10 sm:left-4" />
                <div className="ml-8 h-px flex-1 bg-destructive sm:ml-12" />
                <span className="ml-2 flex-shrink-0 text-aux text-destructive">{t("now")}</span>
              </div>
            )}
            <div className={`relative mb-3 flex items-start ${past ? "opacity-50" : ""}`}>
              <div
                className={`absolute left-[6px] top-4 h-3 w-3 rounded-full border-2 z-10 sm:left-[18px] ${
                  routine.enabled
                    ? recurring
                      ? "border-brand bg-brand"
                      : "border-info bg-info"
                    : "border-border-strong bg-border-strong"
                }`}
              />

              <div className="ml-8 flex-1 rounded-12 border border-border bg-surface p-3 shadow-1 sm:ml-12 sm:p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-section text-foreground">
                        {routineDisplayName(routine)}
                      </h3>
                      <TriggerBadge trigger={routine.trigger} />
                      {!routine.enabled && (
                        <Badge variant="muted">{t("routine.badgeDisabled")}</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-aux text-muted-foreground">
                      <span>
                        {routine.nextRunAt
                          ? formatDateTime(t, routine.nextRunAt)
                          : t("routine.noNextRun")}
                      </span>
                      <span className="hidden sm:inline">·</span>
                      <span>{artifactLocalName(routine.actionName)}</span>
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1 self-end sm:self-auto">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onToggle(routine.id, !routine.enabled)}
                      className={
                        routine.enabled
                          ? "text-muted-foreground"
                          : "text-success-fg hover:bg-success-bg"
                      }
                    >
                      {routine.enabled ? t("routine.disable") : t("routine.enable")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDelete(routine.id)}
                      disabled={!!routine.managedBy}
                      title={
                        routine.managedBy
                          ? t("managed.deleteDisabled", {
                              app: routine.managedBy,
                            })
                          : undefined
                      }
                      className="text-destructive hover:bg-destructive-bg"
                    >
                      {t("routine.delete")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {nowIndex === -1 && sorted.length > 0 && (
        <div className="relative flex items-center py-2">
          <div className="absolute left-4 h-3 w-3 rounded-full border-2 border-destructive bg-destructive ring-2 ring-destructive-border z-10" />
          <div className="ml-12 h-px flex-1 bg-destructive" />
          <span className="ml-2 flex-shrink-0 text-aux text-destructive">{t("now")}</span>
        </div>
      )}

      {sorted.length === 0 && routines.length === 0 && (
        <div className="py-12 text-center text-ui text-subtle-foreground">
          {t("routine.noRoutinesScheduled")}
        </div>
      )}
    </div>
  );
}

function CalendarView({ routines }: { routines: Routine[] }) {
  const { t } = useTranslation("routines");
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  const scheduleOnly = useMemo(() => routines.filter(isSchedule), [routines]);
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);

  const routinesByDate = useMemo(() => {
    const map = new Map<string, Routine[]>();
    for (const r of scheduleOnly) {
      const dateStr = r.nextRunAt;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const arr = map.get(key) || [];
      arr.push(r);
      map.set(key, arr);
    }
    return map;
  }, [scheduleOnly]);

  const monthName = t(`calendar.months.${month}`);
  const dayNames = [0, 1, 2, 3, 4, 5, 6].map((i) => t(`calendar.dayShort.${i}`));

  const prevMonth = () => {
    if (month === 0) {
      setMonth(11);
      setYear(year - 1);
    } else {
      setMonth(month - 1);
    }
    setSelectedDay(null);
  };

  const nextMonth = () => {
    if (month === 11) {
      setMonth(0);
      setYear(year + 1);
    } else {
      setMonth(month + 1);
    }
    setSelectedDay(null);
  };

  const selectedDateKey = selectedDay !== null ? `${year}-${month}-${selectedDay}` : null;
  const selectedRoutines = selectedDateKey ? routinesByDate.get(selectedDateKey) || [] : [];

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex items-center justify-between">
          <IconButton
            label={t("calendar.prevMonth")}
            size="sm"
            onClick={prevMonth}
            icon={
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            }
          />
          <h3 className="text-body text-foreground">
            {t("calendar.monthYear", { month: monthName, year })}
          </h3>
          <IconButton
            label={t("calendar.nextMonth")}
            size="sm"
            onClick={nextMonth}
            icon={
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            }
          />
        </div>

        <div className="grid grid-cols-7 overflow-hidden rounded-t-12 border border-b-0 border-border [&>*:not(:last-child)]:border-r [&>*:not(:last-child)]:border-border">
          {dayNames.map((d) => (
            <div
              key={d}
              className="bg-surface-muted py-2 text-center text-aux text-muted-foreground"
            >
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 overflow-hidden rounded-b-12 border border-border [&>*]:border-border [&>*:not(:nth-child(7n))]:border-r [&>*:not(:nth-last-child(-n+7))]:border-b">
          {cells.map((day, i) => {
            if (day === null) {
              return <div key={`empty-${i}`} className="h-14 bg-surface p-2 sm:h-20" />;
            }

            const key = `${year}-${month}-${day}`;
            const dayRoutines = routinesByDate.get(key) || [];
            const isToday = isSameDay(new Date(year, month, day), today);
            const isSelected = selectedDay === day;

            return (
              <button
                key={`day-${day}`}
                onClick={() => setSelectedDay(selectedDay === day ? null : day)}
                className={`relative flex h-14 flex-col items-start gap-1 bg-surface p-2 text-left transition-colors hover:bg-info-bg sm:h-20 sm:p-2 ${
                  isSelected ? "ring-2 ring-inset ring-ring" : ""
                }`}
              >
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-badge ${
                    isToday ? "bg-primary text-primary-foreground" : "text-foreground"
                  }`}
                >
                  {day}
                </span>
                {dayRoutines.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {dayRoutines.slice(0, 3).map((r) => {
                      const trigger = r.trigger as ScheduleTrigger;
                      return (
                        <span
                          key={r.id}
                          role="img"
                          aria-label={scheduleSubtypeLabel(t, trigger)}
                          className={`inline-block h-1.5 w-1.5 rounded-full ${
                            trigger.rrule ? "bg-primary" : "bg-info"
                          }`}
                        />
                      );
                    })}
                    {dayRoutines.length > 3 && (
                      <span className="text-aux text-subtle-foreground">
                        +{dayRoutines.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Recurrence must not reach the reader through hue alone. */}
        <div className="mt-3 flex flex-wrap items-center gap-4 text-aux text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
            {t("schedule.subtypeRecurring")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-info" aria-hidden />
            {t("schedule.subtypeOneOff")}
          </span>
        </div>
      </div>

      {selectedDay !== null && (
        <Card className="w-full flex-shrink-0 lg:w-72">
          <CardHeader>
            {/* h4, not CardTitle's h3: this panel sits under the calendar's h3. */}
            <h4 className="text-section">
              {t("calendar.selectedHeading", {
                month: monthName,
                day: selectedDay,
                year,
              })}
            </h4>
          </CardHeader>
          <CardContent>
            {selectedRoutines.length === 0 ? (
              <p className="text-ui text-subtle-foreground">{t("calendar.noRoutinesThisDay")}</p>
            ) : (
              <div className="space-y-2">
                {selectedRoutines.map((r) => {
                  const trigger = r.trigger as ScheduleTrigger;
                  return (
                    <div
                      key={r.id}
                      className="flex flex-col gap-1 rounded-8 border border-border p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${
                            trigger.rrule ? "bg-primary" : "bg-info"
                          }`}
                          aria-hidden
                        />
                        <span className="truncate text-ui text-foreground">
                          {routineDisplayName(r)}
                        </span>
                      </div>
                      <div className="text-aux text-muted-foreground">
                        {trigger.localTime} · {scheduleSubtypeLabel(t, trigger)} ·{" "}
                        {artifactLocalName(r.actionName)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// The friendly replacement for the old data table: every line a guardian reads
// is derived from mechanism (describeTrigger / describeOutcome / describeRun) so
// it can't drift from the schedule. Honors the same search + filter the toolbar
// drives, then groups what's left into "on a schedule" vs "when something
// happens".
function RoutineCardsView({
  routines,
  search,
  filter,
  onToggle,
  onDelete,
  onError,
}: {
  routines: Routine[];
  search: string;
  filter: TableFilter;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation("routines");

  const filtered = useMemo(() => {
    let list = routines;
    if (filter !== "all") {
      list = list.filter((r) => {
        if (filter === "active") return r.enabled;
        if (filter === "disabled") return !r.enabled;
        if (filter === "failing") return isFailing(r);
        if (filter === "schedule") return isSchedule(r);
        if (filter === "event-bus") return isEventBus(r);
        if (filter === "manual") return isManual(r);
        return true;
      });
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.actionName.toLowerCase().includes(q) ||
          r.trigger.type.includes(q),
      );
    }
    return list;
  }, [routines, search, filter]);

  if (filtered.length === 0) {
    const hasActiveFilter = search.trim() !== "" || filter !== "all";
    return (
      <div className="rounded-12 border border-border bg-surface-muted/40 px-4 py-12 text-center text-ui text-subtle-foreground">
        {hasActiveFilter ? t("table.emptyFiltered") : t("table.empty")}
      </div>
    );
  }

  // Completed one-off tasks leave the live sections and settle under Done, so
  // past work never crowds what's still scheduled to run.
  const doneRoutines = filtered.filter(isCompletedOneOff);
  const live = filtered.filter((r) => !isCompletedOneOff(r));
  const scheduleRoutines = live.filter(isSchedule);
  const eventRoutines = live.filter(isEventBus);
  const manualRoutines = live.filter(isManual);

  return (
    <div className="space-y-8">
      <CardsSection
        title={t("sections.schedule.title")}
        routines={scheduleRoutines}
        onToggle={onToggle}
        onDelete={onDelete}
        onError={onError}
      />
      <CardsSection
        title={t("sections.event.title")}
        routines={eventRoutines}
        onToggle={onToggle}
        onDelete={onDelete}
        onError={onError}
      />
      <CardsSection
        title={t("sections.manual.title")}
        routines={manualRoutines}
        onToggle={onToggle}
        onDelete={onDelete}
        onError={onError}
      />
      <DoneSection
        routines={doneRoutines}
        onToggle={onToggle}
        onDelete={onDelete}
        onError={onError}
      />
    </div>
  );
}

function CardsSection({
  title,
  routines,
  onToggle,
  onDelete,
  onError,
}: {
  title: string;
  routines: Routine[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onError: (message: string) => void;
}) {
  if (routines.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-section text-foreground">{title}</h2>
      <div className="space-y-3">
        {routines.map((r) => (
          <RoutineCard
            key={r.id}
            routine={r}
            onToggle={onToggle}
            onDelete={onDelete}
            onError={onError}
          />
        ))}
      </div>
    </section>
  );
}

// Done — completed one-off tasks, behind a disclosure that starts collapsed so
// finished work stays reviewable without crowding the live sections.
function DoneSection({
  routines,
  onToggle,
  onDelete,
  onError,
}: {
  routines: Routine[];
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation("routines");
  const [open, setOpen] = useState(false);
  if (routines.length === 0) return null;
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-8 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="text-section text-foreground">{t("sections.done.title")}</span>
        <Badge variant="muted" className="tabular-nums">
          {routines.length}
        </Badge>
      </button>
      {open && (
        <>
          <p className="text-body text-muted-foreground">{t("sections.done.subtitle")}</p>
          <div className="space-y-3">
            {routines.map((r) => (
              <RoutineCard
                key={r.id}
                routine={r}
                done
                onToggle={onToggle}
                onDelete={onDelete}
                onError={onError}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// "Run now": fires the routine's action immediately — real execution, the same
// path as a scheduled fire. The button disables while the request is in flight,
// and when the routine is already running or paused. A run-level failure surfaces
// on the card via the status badge once the list refetches; a request that never
// reached the server has nothing to refetch, so it reports through `onError`.
function RunNowButton({
  routineId,
  label,
  disabled,
  onError,
}: {
  routineId: string;
  label: string;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation("routines");
  const runNow = useRunRoutineNow();
  const [inFlight, setInFlight] = useState(false);

  const handleRun = async () => {
    if (inFlight || disabled) return;
    setInFlight(true);
    try {
      await runNow(routineId);
    } catch {
      onError(t("errors.runFailed"));
    } finally {
      setInFlight(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleRun}
      disabled={disabled || inFlight}
      aria-label={
        inFlight ? t("run.loadingLabel", { name: label }) : t("run.ariaLabel", { name: label })
      }
      className="gap-2 text-muted-foreground"
    >
      {inFlight ? (
        <Spinner size="sm" label={t("run.loadingLabel", { name: label })} />
      ) : (
        <Play className="h-3.5 w-3.5" aria-hidden />
      )}
      {t("run.now")}
    </Button>
  );
}

// "Stop": forces a running routine's run to a terminal "cancelled". Always
// repairs the persisted status (so a run left stuck "running" by a restart
// clears) and kills a live execution if one exists. Replaces "Run now" while the
// routine shows as running.
function StopButton({
  routineId,
  label,
  onError,
}: {
  routineId: string;
  label: string;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation("routines");
  const stop = useStopRoutine();
  const [inFlight, setInFlight] = useState(false);

  const handleStop = async () => {
    if (inFlight) return;
    setInFlight(true);
    try {
      await stop(routineId);
    } catch {
      onError(t("errors.stopFailed"));
    } finally {
      setInFlight(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleStop}
      disabled={inFlight}
      aria-label={
        inFlight ? t("stop.loadingLabel", { name: label }) : t("stop.ariaLabel", { name: label })
      }
      className="gap-2 border-destructive/30 text-destructive-fg hover:bg-destructive/10 hover:text-destructive-fg"
    >
      {inFlight ? (
        <Spinner size="sm" label={t("stop.loadingLabel", { name: label })} />
      ) : (
        <Square className="h-3.5 w-3.5" aria-hidden />
      )}
      {t("stop.now")}
    </Button>
  );
}

function RoutineCard({
  routine,
  done = false,
  onToggle,
  onDelete,
  onError,
}: {
  routine: Routine;
  // Rendered inside the Done section: the card carries a Done badge and its
  // subline reports when it ran instead of a (nonexistent) next run.
  done?: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation("routines");
  const runNow = useRunRoutineNow();

  const triggerPhrase = describeTrigger(routine.trigger);
  const outcomePhrase = describeOutcome(routine.actionName, routine.args);
  // The guardian-written name is the routine's intent and headlines the row.
  // Agent-created routines often carry a machine name equal to the action — no
  // real name to show — so the humanized action phrase becomes the title.
  const trimmedName = routine.name.trim();
  const hasMeaningfulName =
    trimmedName !== "" &&
    trimmedName !== routine.actionName &&
    trimmedName !== artifactLocalName(routine.actionName);
  const title = routineDisplayName(routine);
  const accessibleName = hasMeaningfulName ? trimmedName : `${triggerPhrase}, ${outcomePhrase}`;

  // Only a truly-running run is stoppable. A pending_approval run has no live
  // process to kill, so it keeps the normal Run-now control.
  const isStoppable = routine.lastRun?.status === "running";

  // A routine owned by an app is the app's to remove: the delete control is
  // disabled (and the server refuses it too), so the user can't prune something
  // the app recreates on its next sync.
  const managedBy = routine.managedBy ?? null;

  // Subline: "{cadence} · next run {value}". Only a future next-run is shown, and
  // only its value lands in the primary color (the rest stays muted). relativeTime
  // yields "in 49 minutes" / "tomorrow" / a weekday — peel a leading "in " so the
  // bare value carries the emphasis.
  const nextRel =
    routine.enabled && routine.nextRunAt && !isPast(routine.nextRunAt)
      ? relativeTime(routine.nextRunAt)
      : null;
  const nextRun = nextRel
    ? nextRel.startsWith("in ")
      ? { lead: "next run in ", value: nextRel.slice(3) }
      : { lead: "next run ", value: nextRel }
    : null;

  const handleMenuRun = async () => {
    if (!routine.enabled || isStoppable) return;
    try {
      await runNow(routine.id);
    } catch {
      onError(t("errors.runFailed"));
    }
  };

  // Two non-overlapping zones: a text-only link that navigates, and a sibling
  // action cluster that never does. The flex gap is dead space between them, so
  // a near-miss on the controls can't trigger navigation.
  return (
    <div className="flex items-center justify-between gap-4 rounded-12 border border-border bg-surface px-4 py-3 shadow-1">
      {/* Left zone — the ONLY navigation target. Wraps text content only; no
          interactive elements live inside the link. */}
      <Link
        to={`/routines/${routine.id}`}
        aria-label={accessibleName}
        className="group flex min-w-0 flex-1 items-center gap-3 rounded-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={`h-2 w-2 flex-none rounded-full ${
            routine.enabled ? "bg-success" : "bg-muted-foreground"
          }`}
          aria-hidden
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-section text-foreground group-hover:underline">{title}</p>
            {done && (
              <Badge variant="success" className="shrink-0">
                <Check aria-hidden />
                {t("done.badge")}
              </Badge>
            )}
          </div>
          <p className="truncate text-aux text-muted-foreground">
            <span>{triggerPhrase}</span>
            {nextRun && (
              <>
                <span> · {nextRun.lead}</span>
                <span className="text-foreground">{nextRun.value}</span>
              </>
            )}
            {done && routine.lastFiredAt && (
              <span> · {t("done.ranAt", { when: relativeTime(routine.lastFiredAt) })}</span>
            )}
            {managedBy && <span> · {t("managed.badge", { app: managedBy })}</span>}
          </p>
        </div>
      </Link>

      {/* Right zone — actions; never navigates. */}
      <div className="flex flex-none items-center gap-2">
        {isStoppable ? (
          <StopButton routineId={routine.id} label={accessibleName} onError={onError} />
        ) : (
          <RunNowButton
            routineId={routine.id}
            label={accessibleName}
            disabled={!routine.enabled}
            onError={onError}
          />
        )}
        <Switch
          checked={routine.enabled}
          onCheckedChange={(checked) => onToggle(routine.id, checked)}
          aria-label={t("toggle.ariaLabel", { name: accessibleName })}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="sm"
              label={t("menu.ariaLabel")}
              icon={<MoreHorizontal />}
              className="text-muted-foreground hover:text-foreground"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!routine.enabled || isStoppable} onSelect={handleMenuRun}>
              {t("run.now")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={!!managedBy}
              onSelect={() => {
                if (!managedBy) onDelete(routine.id);
              }}
            >
              {managedBy ? t("managed.deleteDisabled", { app: managedBy }) : t("delete.menuItem")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// The single confirmation every delete path goes through. It lives on the page
// rather than in a view so Timeline and the card list can't diverge on whether a
// delete is guarded.
function DeleteRoutineDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("routines");
  return (
    <Dialog open={open} onClose={onCancel} size="sm" modal>
      <DialogHeader>
        <DialogTitle>{t("delete.dialogTitle")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-body text-muted-foreground">{t("delete.dialogBody")}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {t("delete.cancel")}
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          {t("delete.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

const FREQUENCY_CODES = ["DAILY", "WEEKLY", "MONTHLY"] as const;
const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const DEFAULT_SCHEDULE_DELAY_MS = 3 * 60 * 1_000;

function TriggerTilePicker({
  value,
  onChange,
}: {
  value: TriggerType;
  onChange: (t: TriggerType) => void;
}) {
  const { t } = useTranslation("routines");
  const labelId = useId();
  // `size-4`: the tile's title is `text-ui`, and a 20px line box takes the 16px
  // icon step.
  const tiles: { type: TriggerType; icon: React.ReactNode }[] = [
    {
      type: "schedule",
      icon: <Clock className="size-4 flex-shrink-0" aria-hidden />,
    },
    {
      type: "event-bus",
      icon: <Radio className="size-4 flex-shrink-0" aria-hidden />,
    },
    {
      type: "manual",
      icon: <Play className="size-4 flex-shrink-0" aria-hidden />,
    },
  ];

  return (
    <Field>
      <FieldGroupLabel id={labelId}>{t("modal.fields.triggerType")}</FieldGroupLabel>
      <div role="group" aria-labelledby={labelId} className="grid grid-cols-3 gap-2">
        {tiles.map((tile) => (
          <Tile
            key={tile.type}
            selected={value === tile.type}
            onClick={() => onChange(tile.type)}
            icon={tile.icon}
            title={t(`trigger.${tile.type}`)}
            description={t(`modal.triggerDescriptions.${tile.type}`)}
          />
        ))}
      </div>
    </Field>
  );
}

// Searchable combobox over the live action catalog (GET /api/actions). Users
// don't remember action names, so free-typing is only the degraded path (see
// the caller's fallback when the catalog can't be loaded) — the picker is the
// primary way to bind a routine to an action.
function ActionPicker({
  id,
  value,
  entries,
  invalid,
  onSelect,
}: {
  id: string;
  value: string;
  entries: ActionCatalogEntry[];
  invalid?: boolean;
  onSelect: (entry: ActionCatalogEntry) => void;
}) {
  const { t } = useTranslation("routines");
  const [open, setOpen] = useState(false);
  // A modal popover becomes the active scroll-lock boundary while open. Without
  // it, the parent dialog treats the portalled list as outside and cancels wheels.
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          className={cn(
            "w-full justify-between",
            invalid && "border-destructive focus-visible:ring-destructive/20",
          )}
        >
          {value ? (
            <span className="truncate font-mono">{artifactLocalName(value)}</span>
          ) : (
            <span className="text-muted-foreground">{t("modal.actionPicker.placeholder")}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={t("modal.actionPicker.searchPlaceholder")} />
          <CommandList>
            <CommandEmpty>{t("modal.actionPicker.empty")}</CommandEmpty>
            <CommandGroup>
              {entries.map((entry) => (
                <CommandItem
                  key={entry.name}
                  // Name + description both feed cmdk's filter so "telegram"
                  // finds send_message even though the name doesn't contain it.
                  value={`${entry.name} ${entry.description}`}
                  onSelect={() => {
                    onSelect(entry);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "size-4 shrink-0 self-start mt-1",
                      entry.name === value ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-ui">
                        {artifactLocalName(entry.name)}
                      </span>
                      {entry.ownerType === "app" && (
                        <span className="shrink-0 text-aux text-subtle-foreground">
                          {entry.ownerId}
                        </span>
                      )}
                      {entry.requiresApproval && (
                        <Badge variant="warning" shape="square" className="shrink-0">
                          {t("modal.actionPicker.needsApproval")}
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-aux text-muted-foreground">
                      {entry.description}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Cheat sheet for the selected action's arguments, rendered from its JSON
// Schema so the user can fill the args field without leaving the modal.
function ActionArgsHelp({ action }: { action: ActionCatalogEntry }) {
  const { t } = useTranslation("routines");
  const schema = action.inputSchema;
  const properties = Object.entries(schema?.properties ?? {});
  const required = new Set(schema?.required ?? []);
  return (
    <div className="space-y-2 rounded-12 bg-surface-muted p-3">
      <p className="text-aux text-muted-foreground">{action.description}</p>
      {properties.length === 0 ? (
        <p className="text-aux text-muted-foreground">{t("modal.actionPicker.noArgs")}</p>
      ) : (
        <ul className="space-y-1">
          {properties.map(([name, prop]) => (
            <li key={name} className="text-aux">
              <span className="font-mono text-foreground">{name}</span>
              <span className="text-muted-foreground"> · {describeArgType(prop)}</span>
              {required.has(name) && (
                <span className="text-destructive"> · {t("modal.actionPicker.required")}</span>
              )}
              {typeof prop.description === "string" && prop.description && (
                <span className="text-muted-foreground"> — {prop.description}</span>
              )}
              {Array.isArray(prop.enum) && prop.enum.length > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  ({t("modal.actionPicker.oneOf")} {prop.enum.map(String).join(", ")})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateRoutineModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation("routines");
  const scheduleSubtypeLabelId = useId();
  // Server/network failures are not field validation, so they render in a
  // dedicated banner rather than against any single field.
  const [serverError, setServerError] = useState("");

  // Live action catalog — fetched fresh on every modal open (the hook mounts
  // with the modal and uses staleTime 0) so mid-session app installs show up.
  const {
    actions: actionCatalog,
    isLoading: actionsLoading,
    error: actionsError,
  } = useActionCatalog();
  const actionsByName = useMemo(
    () => new Map((actionCatalog ?? []).map((a) => [a.name, a])),
    [actionCatalog],
  );
  // The last args template this modal seeded. Comparing against it tells us
  // whether the user has hand-edited the args, so switching actions can safely
  // replace an untouched template without ever clobbering typed input.
  const lastSeededArgs = useRef("{}");
  // Snapshot these when the modal opens so a fresh one-off is immediately
  // usable without picking a date or replacing a stale hard-coded time.
  const defaultSchedule = useMemo(() => {
    const now = new Date();
    const requestedTime = new Date(now.getTime() + DEFAULT_SCHEDULE_DELAY_MS);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 0, 0);
    // Keep the default on today even when the three-minute offset crosses
    // midnight. 23:59 is the latest value the minute-precision input can hold.
    const scheduledTime = requestedTime > endOfToday ? endOfToday : requestedTime;
    return {
      localTime: format(scheduledTime, "HH:mm"),
      startDate: format(scheduledTime, "yyyy-MM-dd"),
    };
  }, []);

  // One schema for the whole form: the trigger fields are cross-dependent
  // (which ones are required depends on triggerType / scheduleSubtype /
  // frequency), so a flat per-field validator can't express the rules.
  // superRefine attaches each issue to the field that owns it via `path`, and
  // TanStack maps those onto field-level `meta.errors`.
  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string(),
          triggerType: z.enum(["schedule", "event-bus", "manual"]),
          scheduleSubtype: z.enum(["one-off", "recurring"]),
          tzid: z.string(),
          localTime: z.string(),
          startDate: z.string(),
          frequency: z.string(),
          selectedDays: z.array(z.string()),
          dayOfMonth: z.string(),
          eventName: z.string(),
          sourcePattern: z.string(),
          actionName: z.string(),
          argsText: z.string(),
        })
        .superRefine((v, ctx) => {
          if (!v.name.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["name"],
              message: t("modal.errors.nameRequired"),
            });
          }
          const actionName = v.actionName.trim();
          if (!actionName) {
            ctx.addIssue({
              code: "custom",
              path: ["actionName"],
              message: t("modal.errors.nameRequired"),
            });
          }
          // The server rejects unregistered actions; surface that before
          // submit when the catalog is available. An empty/unloaded catalog
          // (fetch failed) skips this so the manual-entry fallback still works.
          const selectedAction = actionsByName.get(actionName);
          if (actionName && actionsByName.size > 0 && !selectedAction) {
            ctx.addIssue({
              code: "custom",
              path: ["actionName"],
              message: t("modal.errors.unknownAction", { name: actionName }),
            });
          }
          const argsEvaluation = evaluateArgsText(v.argsText, selectedAction?.inputSchema);
          if (argsEvaluation.kind === "invalid-json") {
            ctx.addIssue({
              code: "custom",
              path: ["argsText"],
              message: t("modal.errors.invalidJson"),
            });
          } else if (argsEvaluation.kind === "not-object") {
            ctx.addIssue({
              code: "custom",
              path: ["argsText"],
              message: t("modal.errors.argsObject"),
            });
          } else if (argsEvaluation.kind === "invalid") {
            // Full JSON Schema validation keeps this submit gate aligned with
            // the positive-validity signal below.
            for (const issue of argsEvaluation.issues) {
              ctx.addIssue({
                code: "custom",
                path: ["argsText"],
                message:
                  issue.kind === "missing"
                    ? t("modal.errors.argMissing", { name: issue.name })
                    : issue.kind === "type"
                      ? t("modal.errors.argType", {
                          name: issue.name,
                          expected: issue.expected,
                        })
                      : issue.kind === "unknown"
                        ? t("modal.errors.argUnknown", { name: issue.name })
                        : t("modal.errors.argSchema", {
                            path: issue.path,
                            message: issue.message,
                          }),
              });
            }
          }
          if (v.triggerType === "schedule") {
            if (v.scheduleSubtype === "one-off" && !v.startDate) {
              ctx.addIssue({
                code: "custom",
                path: ["startDate"],
                message: t("modal.errors.startDateRequired"),
              });
            }
            if (
              v.scheduleSubtype === "recurring" &&
              v.frequency === "WEEKLY" &&
              v.selectedDays.length === 0
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["selectedDays"],
                message: t("modal.errors.weekdayRequired"),
              });
            }
            if (v.scheduleSubtype === "recurring" && v.frequency === "MONTHLY") {
              const monthDay = Number(v.dayOfMonth);
              if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
                ctx.addIssue({
                  code: "custom",
                  path: ["dayOfMonth"],
                  message: t("modal.errors.dayOfMonthRequired"),
                });
              }
            }
          } else if (v.triggerType === "event-bus" && !v.eventName.trim()) {
            // `manual` needs no trigger config, so it's validated by neither
            // branch — only its name/action/args (checked above) matter.
            ctx.addIssue({
              code: "custom",
              path: ["eventName"],
              message: t("modal.errors.eventNameRequired"),
            });
          }
        }),
    [t, actionsByName],
  );

  const form = useForm({
    defaultValues: {
      name: "",
      triggerType: "schedule" as TriggerType,
      scheduleSubtype: "one-off" as "one-off" | "recurring",
      tzid: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localTime: defaultSchedule.localTime,
      startDate: defaultSchedule.startDate,
      frequency: "WEEKLY",
      selectedDays: [] as string[],
      dayOfMonth: "1",
      eventName: "",
      sourcePattern: "",
      actionName: "",
      argsText: "{}",
    },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      setServerError("");
      // The schema already validated argsText is a JSON object, so this parse
      // cannot throw here — onSubmit only runs after onSubmit validation passes.
      const args = JSON.parse(value.argsText) as Record<string, unknown>;

      let trigger: Trigger;
      if (value.triggerType === "schedule") {
        let rrule: string | undefined;
        if (value.scheduleSubtype === "recurring") {
          let rule = `FREQ=${value.frequency}`;
          if (value.frequency === "WEEKLY") {
            rule += `;BYDAY=${value.selectedDays.join(",")}`;
          } else if (value.frequency === "MONTHLY") {
            rule += `;BYMONTHDAY=${Number(value.dayOfMonth)}`;
          }
          rrule = rule;
        }
        trigger = {
          type: "schedule",
          tzid: value.tzid,
          // A one-off is an absolute instant → pin it (fixed); a recurring
          // schedule follows the guardian (floating). The server
          // re-pins dated one-offs to fixed regardless, so this just keeps the
          // optimistic payload honest.
          tzMode: value.scheduleSubtype === "one-off" ? "fixed" : "floating",
          localTime: value.localTime,
          ...(value.scheduleSubtype === "one-off" ? { date: value.startDate } : {}),
          ...(rrule ? { rrule } : {}),
        };
      } else if (value.triggerType === "event-bus") {
        trigger = {
          type: "event-bus",
          eventName: value.eventName.trim(),
          ...(value.sourcePattern.trim() ? { sourcePattern: value.sourcePattern.trim() } : {}),
        };
      } else {
        trigger = { type: "manual" };
      }

      const body = {
        name: value.name.trim(),
        trigger,
        actionName: value.actionName.trim(),
        args,
        enabled: true,
      };

      try {
        const res = await fetch("/api/routines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setServerError(data.error || t("modal.errors.createFailed"));
          return;
        }
        onCreated();
        onClose();
      } catch {
        setServerError(t("modal.errors.networkError"));
      }
    },
  });

  return (
    <Dialog open onClose={onClose} ariaLabel={t("modal.title")} size="md">
      <DialogHeader onClose={onClose} closeLabel={t("modal.cancel")}>
        <DialogTitle>{t("modal.title")}</DialogTitle>
      </DialogHeader>

      <DialogBody>
        {/* Subscribe once to the values that drive which fields render (and to
            submissionAttempts, which un-gates errors after a submit try) so the
            whole conditional body re-renders coherently when they change. */}
        <form.Subscribe<{
          attempts: number;
          triggerType: TriggerType;
          scheduleSubtype: "one-off" | "recurring";
          frequency: string;
          actionName: string;
        }>
          selector={(s) => ({
            attempts: s.submissionAttempts,
            triggerType: s.values.triggerType,
            scheduleSubtype: s.values.scheduleSubtype,
            frequency: s.values.frequency,
            actionName: s.values.actionName,
          })}
        >
          {({ attempts, triggerType, scheduleSubtype, frequency, actionName }) => {
            const showError = (meta: { isTouched: boolean; errors: readonly unknown[] }) =>
              (attempts > 0 || meta.isTouched) && meta.errors.length > 0;
            const selectedAction = actionsByName.get(actionName.trim());
            // Fall back to free-text entry only once the catalog has settled and
            // turned out unusable (fetch failed or empty) — an in-flight fetch is
            // its own state, so a pending catalog never reads as a broken one.
            const pickerAvailable = (actionCatalog?.length ?? 0) > 0;
            return (
              <div className="space-y-4">
                <TriggerTilePicker
                  value={triggerType}
                  onChange={(v) => form.setFieldValue("triggerType", v)}
                />

                <form.Field name="name">
                  {(field) => {
                    const invalid = showError(field.state.meta);
                    return (
                      <Field>
                        <FieldLabel htmlFor="routine-name">{t("modal.fields.name")}</FieldLabel>
                        <Input
                          id="routine-name"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          placeholder={t("modal.placeholders.name")}
                          aria-invalid={invalid || undefined}
                        />
                        <FieldError errors={invalid ? field.state.meta.errors : undefined} />
                      </Field>
                    );
                  }}
                </form.Field>

                {triggerType === "schedule" && (
                  <>
                    <Field>
                      <FieldGroupLabel id={scheduleSubtypeLabelId}>
                        {t("modal.fields.scheduleSubtype")}
                      </FieldGroupLabel>
                      <div
                        role="group"
                        aria-labelledby={scheduleSubtypeLabelId}
                        className="flex gap-2"
                      >
                        {(["one-off", "recurring"] as const).map((opt) => {
                          const selected = scheduleSubtype === opt;
                          const selectedClass =
                            opt === "recurring"
                              ? "bg-brand/15 text-brand ring-1 ring-brand/30 hover:bg-brand/15"
                              : "bg-info-bg text-info-fg ring-1 ring-info-border hover:bg-info-bg";
                          return (
                            <Button
                              key={opt}
                              variant="secondary"
                              onClick={() => form.setFieldValue("scheduleSubtype", opt)}
                              className={selected ? selectedClass : "text-muted-foreground"}
                            >
                              {t(`schedule.subtype${opt === "recurring" ? "Recurring" : "OneOff"}`)}
                            </Button>
                          );
                        })}
                      </div>
                    </Field>

                    <form.Field name="tzid">
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor="routine-tzid">
                            {t("modal.fields.timezone")}
                          </FieldLabel>
                          <Input
                            id="routine-tzid"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            onBlur={field.handleBlur}
                          />
                        </Field>
                      )}
                    </form.Field>

                    <div className="grid grid-cols-2 gap-3">
                      <form.Field name="localTime">
                        {(field) => (
                          <Field>
                            <FieldLabel htmlFor="routine-localtime">
                              {t("modal.fields.localTime")}
                            </FieldLabel>
                            <Input
                              id="routine-localtime"
                              type="time"
                              value={field.state.value}
                              onChange={(e) => field.handleChange(e.target.value)}
                              onBlur={field.handleBlur}
                              className="appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                            />
                          </Field>
                        )}
                      </form.Field>
                      {scheduleSubtype === "one-off" && (
                        <form.Field name="startDate">
                          {(field) => {
                            const invalid = showError(field.state.meta);
                            return (
                              <Field>
                                <FieldLabel htmlFor="routine-startdate">
                                  {t("modal.fields.startDate")}
                                </FieldLabel>
                                <DatePickerInput
                                  id="routine-startdate"
                                  value={field.state.value}
                                  onChange={field.handleChange}
                                  onBlur={field.handleBlur}
                                  invalid={invalid}
                                  placeholder={t("modal.placeholders.startDate")}
                                />
                                <FieldError
                                  errors={invalid ? field.state.meta.errors : undefined}
                                />
                              </Field>
                            );
                          }}
                        </form.Field>
                      )}
                    </div>

                    {scheduleSubtype === "recurring" && (
                      <div className="space-y-3 rounded-12 bg-surface-muted p-4">
                        <form.Field name="frequency">
                          {(field) => (
                            <Field>
                              <FieldLabel htmlFor="routine-frequency">
                                {t("modal.fields.frequency")}
                              </FieldLabel>
                              <Select value={field.state.value} onValueChange={field.handleChange}>
                                <SelectTrigger id="routine-frequency" className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {FREQUENCY_CODES.map((code) => (
                                    <SelectItem key={code} value={code}>
                                      {t(`frequencies.${code}`)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </Field>
                          )}
                        </form.Field>

                        {frequency === "WEEKLY" && (
                          <form.Field name="selectedDays">
                            {(field) => {
                              const invalid = showError(field.state.meta);
                              const days = field.state.value;
                              const toggleDay = (code: string) => {
                                field.handleChange(
                                  days.includes(code)
                                    ? days.filter((d) => d !== code)
                                    : [...days, code],
                                );
                                field.handleBlur();
                              };
                              return (
                                <Field>
                                  <FieldLabel>{t("modal.fields.daysOfWeek")}</FieldLabel>
                                  <div className="flex flex-wrap gap-1">
                                    {WEEKDAY_CODES.map((code) => (
                                      <Button
                                        key={code}
                                        size="sm"
                                        variant={days.includes(code) ? "default" : "secondary"}
                                        onClick={() => toggleDay(code)}
                                      >
                                        {t(`weekdays.${code}`)}
                                      </Button>
                                    ))}
                                  </div>
                                  <FieldError
                                    errors={invalid ? field.state.meta.errors : undefined}
                                  />
                                </Field>
                              );
                            }}
                          </form.Field>
                        )}

                        {frequency === "MONTHLY" && (
                          <form.Field name="dayOfMonth">
                            {(field) => {
                              const invalid = showError(field.state.meta);
                              return (
                                <Field>
                                  <FieldLabel htmlFor="routine-daymonth">
                                    {t("modal.fields.dayOfMonth")}
                                  </FieldLabel>
                                  <Input
                                    id="routine-daymonth"
                                    type="number"
                                    min={1}
                                    max={31}
                                    value={field.state.value}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                    onBlur={field.handleBlur}
                                    aria-invalid={invalid || undefined}
                                  />
                                  <FieldError
                                    errors={invalid ? field.state.meta.errors : undefined}
                                  />
                                </Field>
                              );
                            }}
                          </form.Field>
                        )}
                      </div>
                    )}
                  </>
                )}

                {triggerType === "event-bus" && (
                  <>
                    <form.Field name="eventName">
                      {(field) => {
                        const invalid = showError(field.state.meta);
                        return (
                          <Field>
                            <FieldLabel htmlFor="routine-eventname">
                              {t("modal.fields.eventName")}
                            </FieldLabel>
                            <Input
                              id="routine-eventname"
                              list="routine-event-names"
                              value={field.state.value}
                              onChange={(e) => field.handleChange(e.target.value)}
                              onBlur={field.handleBlur}
                              placeholder={t("modal.placeholders.eventName")}
                              className="font-mono"
                              aria-invalid={invalid || undefined}
                            />
                            <datalist id="routine-event-names">
                              <option value="action:completed" />
                              <option value="action:failed" />
                              <option value="message:received" />
                              <option value="approval:resolved" />
                              <option value="routine:fired" />
                            </datalist>
                            <p className="text-aux text-muted-foreground">
                              {t("modal.hints.eventName")}
                            </p>
                            <FieldError errors={invalid ? field.state.meta.errors : undefined} />
                          </Field>
                        );
                      }}
                    </form.Field>
                    <form.Field name="sourcePattern">
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor="routine-sourcepattern">
                            {t("modal.fields.sourcePattern")}
                          </FieldLabel>
                          <Input
                            id="routine-sourcepattern"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            onBlur={field.handleBlur}
                            placeholder={t("modal.placeholders.sourcePattern")}
                            className="font-mono"
                          />
                          <p className="text-aux text-muted-foreground">
                            {t("modal.hints.sourcePattern")}
                          </p>
                        </Field>
                      )}
                    </form.Field>
                  </>
                )}

                {triggerType === "manual" && (
                  <p className="text-body text-muted-foreground">{t("modal.hints.manual")}</p>
                )}

                <form.Field name="actionName">
                  {(field) => {
                    const invalid = showError(field.state.meta);
                    return (
                      <Field>
                        <FieldLabel htmlFor="routine-actionname">
                          {t("modal.fields.actionName")}
                        </FieldLabel>
                        {actionsLoading ? (
                          <Button
                            id="routine-actionname"
                            variant="outline"
                            disabled
                            aria-label={t("modal.actionPicker.loading")}
                            className="w-full justify-between"
                          >
                            <span aria-hidden className="text-muted-foreground">
                              {t("modal.actionPicker.loading")}
                            </span>
                            <Spinner label={t("modal.actionPicker.loading")} />
                          </Button>
                        ) : pickerAvailable ? (
                          <ActionPicker
                            id="routine-actionname"
                            value={field.state.value}
                            entries={actionCatalog ?? []}
                            invalid={invalid}
                            onSelect={(entry) => {
                              field.handleChange(entry.name);
                              field.handleBlur();
                              // Seed the args template only while the user
                              // hasn't typed their own args (still empty, "{}",
                              // or exactly the previous seed).
                              const currentArgs = form.getFieldValue("argsText").trim();
                              const untouched =
                                currentArgs === "" ||
                                currentArgs === "{}" ||
                                currentArgs === lastSeededArgs.current;
                              if (untouched) {
                                const template = buildArgsTemplate(entry.inputSchema);
                                lastSeededArgs.current = template;
                                form.setFieldValue("argsText", template);
                              }
                            }}
                          />
                        ) : (
                          <>
                            <Input
                              id="routine-actionname"
                              value={field.state.value}
                              onChange={(e) => field.handleChange(e.target.value)}
                              onBlur={field.handleBlur}
                              placeholder={t("modal.placeholders.actionName")}
                              className="font-mono"
                              aria-invalid={invalid || undefined}
                            />
                            {actionsError != null && (
                              <p className="text-aux text-muted-foreground">
                                {t("modal.actionPicker.listUnavailable")}
                              </p>
                            )}
                          </>
                        )}
                        <FieldError errors={invalid ? field.state.meta.errors : undefined} />
                      </Field>
                    );
                  }}
                </form.Field>

                {selectedAction && <ActionArgsHelp action={selectedAction} />}

                <form.Field name="argsText">
                  {(field) => {
                    const invalid = showError(field.state.meta);
                    // Only a standards-validated schema result earns the
                    // positive state. Event-only actions with no schema remain
                    // neutral rather than being marked conclusively valid.
                    const argsValid =
                      evaluateArgsText(field.state.value, selectedAction?.inputSchema).kind ===
                      "valid";
                    return (
                      <Field>
                        <div className="flex items-center justify-between">
                          <FieldLabel htmlFor="routine-args">
                            {t("modal.fields.argsJson")}
                          </FieldLabel>
                          {selectedAction && selectedAction.inputSchema != null && (
                            <Button
                              size="xs"
                              variant="ghost"
                              className="text-muted-foreground"
                              onClick={() => {
                                const template = buildArgsTemplate(selectedAction.inputSchema);
                                lastSeededArgs.current = template;
                                form.setFieldValue("argsText", template);
                              }}
                            >
                              {t("modal.actionPicker.insertTemplate")}
                            </Button>
                          )}
                        </div>
                        <Textarea
                          id="routine-args"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          onBlur={field.handleBlur}
                          rows={3}
                          placeholder={t("modal.placeholders.argsJson")}
                          className="font-mono"
                          aria-invalid={invalid || undefined}
                        />
                        {selectedAction && argsValid && (
                          <p className="flex items-center gap-1 text-aux text-success-fg">
                            <Check className="size-3.5 shrink-0" aria-hidden />
                            {t("modal.actionPicker.argsValid", {
                              name: artifactLocalName(selectedAction.name),
                            })}
                          </p>
                        )}
                        <FieldError errors={invalid ? field.state.meta.errors : undefined} />
                      </Field>
                    );
                  }}
                </form.Field>

                {serverError && (
                  <div
                    role="alert"
                    className="rounded-8 bg-destructive-bg px-3 py-2 text-ui text-destructive-fg"
                  >
                    {serverError}
                  </div>
                )}
              </div>
            );
          }}
        </form.Subscribe>
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("modal.cancel")}
        </Button>
        <form.Subscribe<boolean> selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button onClick={() => void form.handleSubmit()} disabled={isSubmitting}>
              {isSubmitting ? t("modal.submitting") : t("modal.submit")}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </Dialog>
  );
}

export default function RoutinesPage() {
  const { t } = useTranslation("routines");
  // List fetching follows the canonical /apps reactivity pattern: TanStack Query
  // owns the cache, and mutations invalidate it to re-read server truth rather
  // than hand-merging fields into local state.
  const { routines: routineData, isLoading: loading, error: loadError, refetch } = useRoutines();
  // The hook types triggers with a wider union (it admits unknown trigger types
  // for the card view's honest fallback); this page's Timeline/Calendar code uses
  // the narrower schedule|event discriminated union. Same JSON at runtime.
  const routines = (routineData ?? []) as Routine[];
  const invalidate = useInvalidateRoutines();
  const [view, setView] = useState<ViewMode>("table");
  const [showCreate, setShowCreate] = useState(false);
  const [tableFilter, setTableFilter] = useState<TableFilter>("all");
  const [tableSearch, setTableSearch] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // Every delete path routes through this one id, so the confirmation can't be
  // skipped by whichever view the guardian happens to be on.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Health surfaces only as a title-side pill, and only when something is wrong.
  // Both the count and the jump-to-failing action are derived here so the pill
  // and the list filter read from the same routines.
  const failing = routines.filter(isFailing).length;
  const showFailing = () => {
    setView("table");
    setTableFilter("failing");
  };

  const readBackendError = async (res: Response, fallbackKey: string): Promise<string> => {
    const data = await res.json().catch(() => ({}));
    return typeof data?.error === "string" && data.error.length > 0 ? data.error : t(fallbackKey);
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/routines/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        setActionError(await readBackendError(res, "errors.toggleFailed"));
        return;
      }
      setActionError(null);
      await invalidate();
    } catch (err) {
      console.error("Failed to toggle routine:", err);
      setActionError(t("errors.networkError"));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/routines/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setActionError(await readBackendError(res, "errors.deleteFailed"));
        return;
      }
      setActionError(null);
      await invalidate();
    } catch (err) {
      console.error("Failed to delete routine:", err);
      setActionError(t("errors.networkError"));
    }
  };

  const viewOptions: {
    value: ViewMode;
    label: string;
    icon: React.ReactNode;
  }[] = [
    {
      value: "table",
      label: t("tabs.list"),
      icon: <ListIcon aria-hidden />,
    },
    {
      value: "calendar",
      label: t("tabs.calendar"),
      icon: <CalendarIcon aria-hidden />,
    },
    {
      value: "timeline",
      label: t("tabs.timeline"),
      icon: <AlignLeft aria-hidden />,
    },
  ];

  const filterOptions: { value: TableFilter; label: string }[] = [
    { value: "all", label: t("filter.all") },
    { value: "active", label: t("filter.active") },
    { value: "disabled", label: t("filter.disabled") },
    { value: "failing", label: t("filter.failing") },
    { value: "schedule", label: t("filter.schedule") },
    { value: "event-bus", label: t("filter.eventBus") },
    { value: "manual", label: t("filter.manual") },
  ];

  const nonScheduleSelected =
    view !== "table" && routines.length > 0 && routines.every((r) => !isSchedule(r));

  return (
    <PageShell>
      <PageBody>
        {/* Header sits above the load switch, so a slow or failed list read
            leaves the page identity and the create action in place instead of
            blanking the whole route. */}
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-title text-foreground">{t("header.title")}</h1>
            <HealthPill failing={failing} onShowFailing={showFailing} />
          </div>
          <Button onClick={() => setShowCreate(true)} className="flex-shrink-0">
            <Plus className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t("header.createButton")}</span>
          </Button>
        </header>

        {actionError && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-12 bg-destructive-bg px-4 py-3 text-ui text-destructive-fg"
          >
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-destructive-fg/70 hover:text-destructive-fg"
              aria-label={t("errors.dismiss")}
            >
              ×
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-ui text-subtle-foreground">{t("loading")}</div>
          </div>
        ) : loadError ? (
          // A failed list read must not fall through to the success layout: an
          // empty list and an unread list look identical there, and the routines
          // are still firing on the server.
          <Alert variant="destructive">
            <AlertTitle>{t("errors.loadFailed")}</AlertTitle>
            <AlertDescription>
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                {t("errors.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <StatsBar routines={routines} />

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <SegmentedControl
                aria-label={t("tabs.viewLabel")}
                value={view}
                onValueChange={(v: string) => setView(v as ViewMode)}
                options={viewOptions}
                className="self-start"
              />

              {view === "table" && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="justify-between gap-2">
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <Filter className="size-4" aria-hidden />
                          <span className="text-foreground">
                            {filterOptions.find((o) => o.value === tableFilter)?.label}
                          </span>
                        </span>
                        <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {filterOptions.map((opt) => (
                        <DropdownMenuItem
                          key={opt.value}
                          onSelect={() => setTableFilter(opt.value)}
                          className={
                            tableFilter === opt.value ? "bg-surface-muted text-foreground" : ""
                          }
                        >
                          {opt.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <div className="relative">
                    <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                      <Search className="h-4 w-4" aria-hidden />
                    </div>
                    <Input
                      placeholder={t("table.filterPlaceholder")}
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      className="pl-8 sm:w-64"
                    />
                  </div>
                </div>
              )}
            </div>

            {nonScheduleSelected && (
              <div className="rounded-12 border border-border bg-surface-muted/60 px-4 py-3 text-ui text-muted-foreground">
                {t(`${view}.scheduleOnly`)}
              </div>
            )}

            {view === "timeline" && (
              <TimelineView
                routines={routines}
                onToggle={handleToggle}
                onDelete={setPendingDelete}
              />
            )}
            {view === "calendar" && <CalendarView routines={routines} />}
            {view === "table" && (
              <RoutineCardsView
                routines={routines}
                search={tableSearch}
                filter={tableFilter}
                onToggle={handleToggle}
                onDelete={setPendingDelete}
                onError={setActionError}
              />
            )}
          </>
        )}
      </PageBody>

      <DeleteRoutineDialog
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id !== null) void handleDelete(id);
        }}
      />

      {showCreate && (
        <CreateRoutineModal onClose={() => setShowCreate(false)} onCreated={invalidate} />
      )}
    </PageShell>
  );
}
