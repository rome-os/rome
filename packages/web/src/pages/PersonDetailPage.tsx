import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { formatWhatsAppPhone, normalizeBondLevel } from "@rome/api-types/people";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageShell, PageBody } from "@/shell/PageShell";
import { Avatar } from "./people/avatar";
import { ChannelPill } from "./people/channel-meta";
import { PersonConversation } from "./people/conversation";
import { PersonManagement } from "./people/manage";
import { PEOPLE_VIEW_PATH, personPath } from "./people/people-model";
import { levelLabelKey } from "./people/rows";
import { usePerson } from "./people/use-roster";

/**
 * One person's page: the dossier.
 *
 * Who they are on top — name, bond, the accounts that resolve to this person —
 * and everything said to or by them below. This file owns the header and the
 * one read behind it, `GET /api/people/:id`; the conversation under it is
 * `people/conversation.tsx`, which owns the timeline, the outbox and the
 * composer together because the three are one surface and settle as one.
 *
 * The management gestures the design puts on this card — the bond select, Link
 * account…, Merge into… — are `people/manage.tsx`, and each settles by
 * invalidating the reads it moved.
 */

/**
 * The route element, keyed by the person it is showing.
 *
 * Navigating from one person to another stays on this route, so React would
 * keep the same instance mounted and every piece of local state with it — now
 * sitting on somebody else's dossier. The key makes "a different person" a
 * different component, which is what it is.
 */
export default function PersonDetailPageRoute() {
  const params = useParams<{ personId: string }>();
  return <PersonDetailPage key={params.personId} personId={params.personId} />;
}

function PersonDetailPage({ personId }: { personId: string | undefined }) {
  const { t } = useTranslation("people");
  const navigate = useNavigate();
  const location = useLocation();

  // Where the dossier was opened from, carried on the navigation that opened
  // it. An origin says a view sits behind this dossier, so the arrow spends the
  // dossier's own history entry rather than stacking a third — otherwise the
  // browser's Back undoes the click that was meant to leave.
  //
  // A merge is why the origin is carried rather than inferred: it deletes this
  // person and puts the survivor in their entry, so the address is what keeps
  // the arrow honest about which view it owes. A dossier reached by pasted link
  // has no view behind it and replaces itself with the one `/people` is.
  const origin = (location.state as { from?: string } | null)?.from;
  const back = () => (origin ? navigate(-1) : navigate(PEOPLE_VIEW_PATH.latest, { replace: true }));

  const personQuery = usePerson(personId);
  const person = personQuery.data ?? null;

  if (personQuery.isPending) {
    return (
      <PageShell>
        <PageBody>
          <p className="py-12 text-center text-ui text-muted-foreground">{t("page.loading")}</p>
        </PageBody>
      </PageShell>
    );
  }

  // A failed read and a person who is genuinely gone are different answers, and
  // both leave `data` undefined. Reporting a network error as "not here" tells
  // the reader the row was removed when nothing was even read, and offers no
  // way to try again.
  if (personQuery.error || !person) {
    const missing = !personQuery.error;
    return (
      <PageShell>
        <PageBody>
          <BackLink onClick={back} />
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>
              {missing ? t("detail.missingTitle") : t("errors.loadFailedTitle")}
            </AlertTitle>
            <AlertDescription>
              {missing ? t("detail.missingBody") : personQuery.error?.message}
            </AlertDescription>
          </Alert>
          {!missing && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void personQuery.refetch()}
            >
              {t("errors.retry")}
            </Button>
          )}
        </PageBody>
      </PageShell>
    );
  }

  return (
    // The page fills the content column so the conversation can take whatever
    // the header leaves, and the composer's floor reaches the viewport's foot.
    <PageShell className="flex flex-1 flex-col">
      <PageBody className="flex flex-1 flex-col">
        <BackLink onClick={back} />

        {/* One row at any width: the avatar, then who this is, then a menu of
            what can be done to them. The bond reads as a badge on the name line
            and is changed from the menu, so the card states the facts and keeps
            every gesture in one place — nothing here has to stack or wrap into
            pieces when the card is narrow. */}
        <div className="flex items-start gap-4 rounded-14 border border-border bg-surface p-5 shadow-1">
          <Avatar
            name={person.displayName}
            size="lg"
            tone="bg-surface-muted text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-title text-foreground">{person.displayName}</h1>
              <Badge variant="outline">
                {t(levelLabelKey(normalizeBondLevel(person.bondLevel)))}
              </Badge>
            </div>
            <p className="text-aux text-muted-foreground">
              {t("row.messageCount", { count: person.messageCount })}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {person.accounts.length === 0 ? (
                <span className="text-aux text-subtle-foreground">{t("detail.noAccounts")}</span>
              ) : (
                person.accounts.map((account) => (
                  <ChannelPill
                    key={`${account.channel}:${account.channelUserId}`}
                    channel={account.channel}
                  >
                    <span className="font-mono tabular-nums">
                      {account.channel === "whatsapp"
                        ? (formatWhatsAppPhone(account.channelUserId) ?? account.channelUserId)
                        : account.channelUserId}
                    </span>
                  </ChannelPill>
                ))
              )}
            </div>
          </div>
          {/* A merge ends with this person gone, so the page that had them open
              follows the account history to the survivor rather than sitting on
              a route that now 404s. It replaces rather than pushes, and hands
              the survivor the same origin: the entry this dossier occupies
              names a person the merge just deleted. */}
          <PersonManagement
            person={person}
            onMerged={(survivorId) =>
              navigate(personPath(survivorId), { replace: true, state: { from: origin } })
            }
          />
        </div>

        <PersonConversation person={person} />
      </PageBody>
    </PageShell>
  );
}

/**
 * The address a person was reached by before the dossier took its own segment.
 *
 * A person id never named a view, so forwarding is unambiguous: `/people/wei-chen`
 * meant that dossier and still reaches it. The two view segments are matched by
 * their own routes ahead of this one and never arrive here.
 */
export function PersonLegacyRedirect() {
  const params = useParams<{ personId: string }>();
  const location = useLocation();
  return <Navigate to={personPath(params.personId ?? "")} state={location.state} replace />;
}

function BackLink({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("people");
  return (
    <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onClick}>
      <ArrowLeft aria-hidden="true" />
      {t("detail.back")}
    </Button>
  );
}
