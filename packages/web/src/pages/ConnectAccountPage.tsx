import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import type { AccountCodeIssued, AccountCodeNoPerson } from "@rome/api-types";
import { Measure, Section, SectionTitle } from "@rome-os/ui/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { PageBody, PageHeader, PageShell } from "@/shell/PageShell";

/** Why asking for a code failed. */
type Failure = "no-person" | "failed";

/** A code and when its response arrived, on the monotonic clock and on the
 *  wall clock. */
interface Received {
  issued: AccountCodeIssued;
  arrivedAt: Clocks;
}

/** One moment read on both clocks: `performance.now()` and `Date.now()`. */
interface Clocks {
  monotonic: number;
  wall: number;
}

const readClocks = (): Clocks => ({ monotonic: performance.now(), wall: Date.now() });

async function requestCode(): Promise<Received | Failure> {
  try {
    const response = await fetch("/api/account-codes", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
    if (response.status === 403) {
      const body = (await response.json().catch(() => null)) as Partial<AccountCodeNoPerson> | null;
      return body?.code === "no_person" ? "no-person" : "failed";
    }
    if (!response.ok) return "failed";
    const issued = (await response.json()) as AccountCodeIssued;
    return { issued, arrivedAt: readClocks() };
  } catch {
    return "failed";
  }
}

/**
 * Milliseconds gone since `from`, the larger of the two clocks' answers, and
 * never below zero. The monotonic clock stands still while the computer
 * sleeps, and the difference of two wall clock readings does not depend on
 * how wrong the browser's clock is, so neither shows an expired code as live.
 */
function elapsedMs(from: Clocks, to: Clocks): number {
  return Math.max(0, to.monotonic - from.monotonic, to.wall - from.wall);
}

/**
 * Seconds the received code has left, ticking each second, never below zero.
 * Counts from when the response arrived, so a browser clock that is wrong
 * does not change it.
 */
function useSecondsLeft(received: Received | null): number | null {
  const [now, setNow] = useState(readClocks);
  useEffect(() => {
    if (received === null) return;
    const lifetimeMs = received.issued.expiresInSeconds * 1000;
    const timer = window.setInterval(() => {
      const current = readClocks();
      setNow(current);
      if (elapsedMs(received.arrivedAt, current) >= lifetimeMs) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [received]);
  if (received === null) return null;
  // A `now` read before the response arrived counts as no time gone, so the
  // first paint of a new code shows its full time.
  const gone = elapsedMs(received.arrivedAt, now);
  return Math.max(0, Math.ceil(received.issued.expiresInSeconds - gone / 1000));
}

function minutesAndSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The connect page (`/connect-account`), the link Rome sends a sender it does
 * not know. The guardian and every member get a code here and send it to Rome
 * from the account they want added. Vocabulary:
 * docs/domains/identity.md#account-code.
 */
export default function ConnectAccountPage() {
  const { t } = useTranslation("settings");
  useDocumentTitle(t("connectAccount.title"));
  const [received, setReceived] = useState<Received | null>(null);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [copyRefused, setCopyRefused] = useState(false);
  const { copiedText, copy } = useCopyFeedback();
  const issued = received?.issued ?? null;
  const secondsLeft = useSecondsLeft(received);
  const live = issued !== null && secondsLeft !== null && secondsLeft > 0;
  const copied = issued !== null && copiedText === issued.code;

  async function ask() {
    setAsking(true);
    setFailure(null);
    setCopyRefused(false);
    const result = await requestCode();
    if (typeof result === "string") setFailure(result);
    else setReceived(result);
    setAsking(false);
  }

  async function copyCode(code: string) {
    setCopyRefused(!(await copy(code)));
  }

  const askButton = (label: string, variant: "default" | "outline") => (
    <Button type="button" variant={variant} disabled={asking} onClick={() => void ask()}>
      {asking ? t("connectAccount.asking") : label}
    </Button>
  );

  return (
    <PageShell>
      <PageBody>
        <PageHeader title={t("connectAccount.title")} />
        <Measure>
          <p className="text-ui">{t("connectAccount.intro")}</p>
        </Measure>

        {live ? (
          <Measure className="space-y-4">
            <div className="space-y-3 rounded-12 border border-border bg-surface p-4">
              <p className="text-aux text-muted-foreground">{t("connectAccount.yourCode")}</p>
              <p className="select-all font-mono text-display [overflow-wrap:anywhere] text-foreground">
                {issued.code}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button type="button" variant="outline" onClick={() => void copyCode(issued.code)}>
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {copied ? t("connectAccount.copied") : t("connectAccount.copy")}
                </Button>
                <p className="text-aux text-muted-foreground tabular-nums">
                  {t("connectAccount.expiresIn", { time: minutesAndSeconds(secondsLeft) })}
                </p>
              </div>
              {copyRefused ? (
                <p role="alert" className="text-aux text-destructive-fg">
                  {t("connectAccount.copyRefused")}
                </p>
              ) : null}
            </div>
            <Section>
              <SectionTitle>{t("connectAccount.stepsTitle")}</SectionTitle>
              <ol className="list-decimal space-y-1 pl-5 text-ui">
                <li>{t("connectAccount.stepOpen")}</li>
                <li>{t("connectAccount.stepSend")}</li>
                <li>{t("connectAccount.stepWait")}</li>
              </ol>
            </Section>
          </Measure>
        ) : null}

        <Measure className="space-y-3">
          {issued !== null && !live ? (
            <p role="status" className="text-ui">
              {t("connectAccount.expired")}
            </p>
          ) : null}
          {failure ? (
            <Alert variant="destructive">
              <AlertTitle>{t("connectAccount.errorTitle")}</AlertTitle>
              {failure === "no-person" ? (
                <AlertDescription>{t("connectAccount.noPerson")}</AlertDescription>
              ) : null}
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {issued === null
              ? askButton(t("connectAccount.getCode"), "default")
              : askButton(t("connectAccount.getNewCode"), live ? "outline" : "default")}
            {live ? (
              <p className="text-aux text-muted-foreground">{t("connectAccount.replaces")}</p>
            ) : null}
          </div>
        </Measure>

        <Measure>
          <Alert variant="warning">
            <AlertTitle>{t("connectAccount.warningTitle")}</AlertTitle>
            <AlertDescription>{t("connectAccount.warningBody")}</AlertDescription>
          </Alert>
        </Measure>
      </PageBody>
    </PageShell>
  );
}
