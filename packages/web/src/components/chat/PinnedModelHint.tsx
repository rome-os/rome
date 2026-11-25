import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChatSession } from "@/lib/chat-types";
import { followDefaultProvider } from "@/lib/chat-api";
import { LARGE_MODEL_OPTIONS } from "@/lib/chat-constants";
import { modelDisplayName } from "@/lib/model-display";
import { modelOptionLabel } from "@/lib/model-options";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { type DefaultModelProvider, useDefaultProvider } from "@/hooks/use-default-provider";

type PinnedModel = NonNullable<ChatSession["pinnedModel"]>;

/** The provider as the guardian reads it elsewhere: Claude, ChatGPT. */
function providerName(providerId: string, t: TFunction<"chat">): string {
  if (providerId === "anthropic") return "Claude";
  if (providerId === "openai") return "ChatGPT";
  if (providerId === "rome_credits") return t("pinnedHint.romeCredits");
  return providerId;
}

/** The model an owner picked, by the names the selector uses, else its provider. */
function pickedName(pin: PinnedModel, provider: string, t: TFunction<"chat">): string {
  const option = LARGE_MODEL_OPTIONS.find((candidate) => candidate.id === pin.selection);
  return pin.model
    ? modelDisplayName(pin.model)
    : option
      ? modelOptionLabel(option, t("modelSelector.options.auto"))
      : provider;
}

/**
 * What a pinned chat says about where it runs: "On ChatGPT" for a kept chat,
 * "You picked Haiku 5.5" for its owner's pick. A held fork names only its
 * provider. docs/domains/agents.md#pinned-chat
 */
export function pinnedHintText(pin: PinnedModel, t: TFunction<"chat">): string {
  const provider = providerName(pin.providerId, t);
  if (pin.by === "owner") return t("pinnedHint.owner", { model: pickedName(pin, provider, t) });
  return t("pinnedHint.kept", { provider });
}

/**
 * What the confirm before Back to default says: where the chat moves from,
 * and the default it follows from its next reply.
 */
export function backToDefaultBody(
  pin: PinnedModel,
  defaultProvider: DefaultModelProvider | null | undefined,
  t: TFunction<"chat">,
): string {
  const provider = providerName(pin.providerId, t);
  if (!defaultProvider) return t("pinnedHint.confirm.bodyNoDefault");
  const to = providerName(defaultProvider, t);
  if (pin.by === "owner") {
    return t("pinnedHint.confirm.bodyOwner", { model: pickedName(pin, provider, t), to });
  }
  return t("pinnedHint.confirm.bodyKept", { from: provider, to });
}

/**
 * The transcript's last row while a chat does not follow the default
 * provider, with "Back to default", which asks first. The caller leaves it
 * out for visitors.
 */
export function PinnedModelHint({
  sessionId,
  pinnedModel,
  onFollowed,
}: {
  sessionId: string;
  pinnedModel: PinnedModel;
  /** The chat as the server returned it, now following the default. */
  onFollowed: (session: ChatSession) => void;
}) {
  const { t } = useTranslation("chat");
  const { data: defaults } = useDefaultProvider();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const follow = async () => {
    setPending(true);
    setFailed(false);
    try {
      onFollowed(await followDefaultProvider(sessionId));
      setConfirming(false);
    } catch {
      setFailed(true);
      setConfirming(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      data-testid="pinned-model-hint"
      className="mb-2 px-1 text-center text-aux text-subtle-foreground"
    >
      {pinnedHintText(pinnedModel, t)} ·{" "}
      <button
        type="button"
        className="cursor-pointer rounded-4 underline underline-offset-2 outline-1 outline-offset-2 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 disabled:cursor-default"
        disabled={pending}
        onClick={() => setConfirming(true)}
      >
        {t("pinnedHint.backToDefault")}
      </button>
      {failed ? <span className="ml-2 text-destructive">{t("pinnedHint.failed")}</span> : null}
      <RomeConfirmDialog
        open={confirming}
        title={t("pinnedHint.confirm.title")}
        description={backToDefaultBody(pinnedModel, defaults?.provider, t)}
        confirmLabel={t("pinnedHint.backToDefault")}
        cancelLabel={t("pinnedHint.confirm.cancel")}
        confirmDisabled={pending}
        onConfirm={() => void follow()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
