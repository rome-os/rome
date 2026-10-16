import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type ApiConnection, createConnection } from "@/lib/connections-api";
import { type ConnectionCard, connectionRoute } from "@/lib/connection-cards";

/**
 * Account controls on a channel card: "Add another account" for services that
 * offer several. It acts on the account (the card's channel), not on a slot,
 * so it sits below the slot cards.
 */

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Whether the card's own Talk (not a folded personal-account slot) is connected. */
function talkConnected(card: ConnectionCard): boolean {
  return card.slots.some((slot) => slot.key !== "session" && slot.state !== "unauthorized");
}

export function AccountControls({
  card,
  onFlash,
  onOpenAccount,
}: {
  card: ConnectionCard;
  onFlash: (message: string) => void;
  /** Open another account's card by its route. Rejects when the account is
   *  not listed yet. Without it, the add button is hidden. */
  onOpenAccount?: (route: string) => void | Promise<void>;
}) {
  const connected = talkConnected(card);
  // A second account only makes sense next to a first one that exists.
  if (!card.severalAccounts || !connected || !onOpenAccount) return null;
  return (
    <AddAccountButton service={card.service} onFlash={onFlash} onOpenAccount={onOpenAccount} />
  );
}

function AddAccountButton({
  service,
  onFlash,
  onOpenAccount,
}: {
  service: string;
  onFlash: (message: string) => void;
  onOpenAccount: (route: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    setAdding(true);
    try {
      const fallback = t("connections.accounts.addFailed");
      let connection: ApiConnection;
      try {
        connection = await createConnection(service, fallback);
      } catch (error) {
        onFlash(errorMessage(error, fallback));
        return;
      }
      // The account exists from here on, so a failure to open it must not read
      // as a failed add: a retry would create another one.
      try {
        // Without a channel the route would be the service, which opens the
        // first account instead of the new one.
        if (!connection.channel) throw new Error("The new account has no channel.");
        await onOpenAccount(connectionRoute(connection));
      } catch {
        // Not an error: the account exists. The Settings tab's `onFlash`
        // shows errors, so this one goes out as a plain toast.
        toast(t("connections.accounts.addedNotShown"));
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <Button type="button" variant="outline" disabled={adding} onClick={() => void add()}>
      <Plus data-icon="inline-start" aria-hidden />
      {t("connections.accounts.add")}
    </Button>
  );
}
