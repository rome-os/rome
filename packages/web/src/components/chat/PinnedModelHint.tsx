import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChatSession } from "@/lib/chat-types";
import { followDefaultProvider } from "@/lib/chat-api";
import { LARGE_MODEL_OPTIONS } from "@/lib/chat-constants";
import { modelDisplayName } from "@/lib/model-display";

type PinnedModel = NonNullable<ChatSession["pinnedModel"]>;

/** The provider as the guardian reads it elsewhere: Claude, ChatGPT. */
function providerName(providerId: string, t: TFunction<"chat">): string {
  if (providerId === "anthropic") return "Claude";
  if (providerId === "openai") return "ChatGPT";
  if (providerId === "rome_credits") return t("pinnedHint.romeCredits");
  return providerId;
}

/**
 * What a pinned chat says about where it runs: "On ChatGPT" for a kept chat,
 * "You picked Haiku 5.5" for its owner's pick. A held fork names only its
 * provider. docs/domains/agents.md#pinned-chat
 */
export function pinnedHintText(pin: PinnedModel, t: TFunction<"chat">): string {
  const provider = providerName(pin.providerId, t);
  if (pin.by === "owner") {
    const option = LARGE_MODEL_OPTIONS.find((candidate) => candidate.id === pin.selection);
    const name = pin.model ? modelDisplayName(pin.model) : option ? t(option.labelKey) : provider;
    return t("pinnedHint.owner", { model: name });
  }
  return t("pinnedHint.kept", { provider });
}

/**
 * The quiet line above the composer while a chat does not follow the default
 * provider, with "Back to default". The caller leaves it out for visitors.
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
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const follow = async () => {
    setPending(true);
    setFailed(false);
    try {
      onFollowed(await followDefaultProvider(sessionId));
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <p data-testid="pinned-model-hint" className="mb-1.5 px-1 text-aux text-subtle-foreground">
      {pinnedHintText(pinnedModel, t)} ·{" "}
      <button
        type="button"
        className="cursor-pointer rounded-4 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        disabled={pending}
        onClick={() => void follow()}
      >
        {t("pinnedHint.backToDefault")}
      </button>
      {failed ? <span className="ml-2 text-destructive">{t("pinnedHint.failed")}</span> : null}
    </p>
  );
}
