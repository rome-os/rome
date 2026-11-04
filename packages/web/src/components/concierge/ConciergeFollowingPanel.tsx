import { BellRing } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ConciergeConnectorDto,
  ConciergeFollowDto,
  ConciergeFollowOptionDto,
} from "@rome/api-types/concierge";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
import { useConciergeFollowing } from "./use-concierge-following";

/** The small grey heading over each source. */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-3 pb-1 pt-4 text-aux text-muted-foreground">{children}</h3>;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An option's value in the guardian's words: an enum's label, a list joined, yes or no. */
function optionText(
  option: ConciergeFollowOptionDto,
  value: string | boolean | string[],
  yes: string,
  no: string,
): string {
  if (option.type === "boolean") return value === true ? yes : no;
  if (option.type === "list") return Array.isArray(value) ? value.join(", ") : String(value);
  return option.values?.find((v) => v.value === value)?.label ?? String(value);
}

function FollowRow({
  connector,
  follow,
}: {
  connector: ConciergeConnectorDto;
  follow: ConciergeFollowDto;
}) {
  const { t } = useTranslation("chat");
  const watch = connector.capabilities.watch;
  const kinds = (watch.kinds ?? [])
    .filter((kind) => follow.kinds.some((k) => k.kind === kind.kind && k.on))
    .map((kind) => kind.label);
  // Only what the guardian changed from the defaults: the rest goes without saying.
  const options = (watch.options ?? []).flatMap((option) => {
    const value = follow.options[option.key];
    if (value === undefined || sameValue(value, option.default)) return [];
    return [
      `${option.label}: ${optionText(option, value, t("concierge.following.yes"), t("concierge.following.no"))}`,
    ];
  });
  return (
    <ListRow asChild size="md">
      <li data-following-item={`${connector.service}:${follow.target}`} className="items-start">
        <ListRowContent>
          <ListRowTitle className="truncate">{follow.target}</ListRowTitle>
          {follow.state !== "active" ? (
            <ListRowDescription>
              {t(`concierge.following.state.${follow.state}`)}
            </ListRowDescription>
          ) : null}
          {kinds.length > 0 ? <ListRowDescription>{kinds.join(" · ")}</ListRowDescription> : null}
          {options.length > 0 ? (
            <ListRowDescription>{options.join(" · ")}</ListRowDescription>
          ) : null}
          {follow.preference ? (
            <ListRowDescription>
              {t("concierge.following.preferenceShown", { preference: follow.preference })}
            </ListRowDescription>
          ) : null}
        </ListRowContent>
      </li>
    </ListRow>
  );
}

/**
 * What the Concierge follows for the guardian, grouped by source, from the
 * same structure the Concierge reads: each follow's target, the kinds on, the
 * options set and the preference. Read-only: the guardian changes a follow by
 * asking the Concierge in chat.
 */
export function ConciergeFollowingPanel() {
  const { t } = useTranslation("chat");
  const { loaded, followed } = useConciergeFollowing();
  if (!loaded) return null;
  if (followed.length === 0) {
    return (
      <EmptyState className="h-full">
        <EmptyStateIcon>
          <BellRing />
        </EmptyStateIcon>
        <EmptyStateTitle>{t("concierge.following.emptyTitle")}</EmptyStateTitle>
        <EmptyStateDescription>{t("concierge.following.emptyDescription")}</EmptyStateDescription>
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto pb-safe">
      {followed.map((connector) => {
        const watch = connector.capabilities.watch;
        // Why its follows are not active now: no access, or connected but degraded.
        const reason =
          watch.state === "unlocked"
            ? watch.degradation?.reason
            : watch.state === "needs-auth"
              ? t("concierge.following.notConnected", { source: connector.label })
              : undefined;
        return (
          <section key={connector.service} data-following-source={connector.service}>
            <SectionHeading>
              {watch.account
                ? t("concierge.following.sourceWithAccount", {
                    source: connector.label,
                    account: watch.account,
                  })
                : connector.label}
            </SectionHeading>
            {reason ? <p className="px-3 pb-1 text-aux text-muted-foreground">{reason}</p> : null}
            <List asChild>
              <ul>
                {watch.follows?.map((follow) => (
                  <FollowRow key={follow.target} connector={connector} follow={follow} />
                ))}
              </ul>
            </List>
          </section>
        );
      })}
      <p className="px-3 pt-4 text-aux text-subtle-foreground">
        {t("concierge.following.changeInChat")}
      </p>
    </div>
  );
}
