import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { WeChatIcon } from "@/components/brand-icons/connection-badges";
import { cn } from "@/lib/utils";

/**
 * What the People page knows about a channel: a name to show, and a glyph to
 * show it with.
 *
 * Channels are drawn as monochrome glyphs, never as colors. The status hues are
 * reserved for status semantics, and there are more channels than a palette has
 * room for — a channel contributed by a Rome App ships an icon here instead of
 * claiming a color. Every glyph draws in `currentColor`, so the surface it sits
 * on decides its weight.
 */
export interface ChannelMeta {
  labelKey: string;
  /** The channel's mark. Omitted when Rome has no monochrome one for it — the
   *  generic glyph stands in, and the name still reads as the channel's own. */
  Glyph?: (props: { className?: string }) => React.JSX.Element;
}

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.2 8.2 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.25 8.24a8.23 8.23 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.26-8.24Zm-3.1 4.2c-.15 0-.4.06-.6.28-.21.22-.8.78-.8 1.9 0 1.11.82 2.19.93 2.34.12.15 1.6 2.44 3.87 3.42.54.23.96.37 1.29.48.54.17 1.03.15 1.42.09.44-.07 1.34-.55 1.53-1.08.19-.53.19-.98.13-1.08-.06-.09-.21-.15-.44-.26-.22-.12-1.34-.66-1.55-.74-.2-.07-.36-.11-.51.12-.15.22-.58.73-.71.88-.13.15-.26.17-.49.06-.22-.12-.94-.35-1.8-1.11-.66-.6-1.11-1.32-1.24-1.55-.13-.22-.02-.34.1-.46.1-.1.22-.26.33-.4.11-.14.15-.23.22-.38.08-.15.04-.28-.02-.4-.06-.11-.5-1.24-.7-1.7-.18-.44-.37-.38-.51-.39l-.44-.01Z" />
    </svg>
  );
}

function TelegramGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M21.6 4.1 2.9 11.3c-.9.34-.9.9-.16 1.13l4.8 1.5 1.85 5.68c.22.6.4.83.83.83.42 0 .6-.19.83-.42l2.28-2.22 4.74 3.5c.87.48 1.5.23 1.72-.8l3.1-14.6c.31-1.27-.49-1.84-1.29-1.48v-.32ZM7.9 13.6l10.28-6.48c.5-.3.97-.14.59.2l-8.8 7.95-.35 3.7-1.72-5.37Z" />
    </svg>
  );
}

function DiscordGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M19.3 5.36A16.8 16.8 0 0 0 15.1 4l-.2.4a15.7 15.7 0 0 1 3.7 1.2 12.9 12.9 0 0 0-11.2 0A15.6 15.6 0 0 1 11.1 4.4L10.9 4a16.8 16.8 0 0 0-4.2 1.36C4 9.4 3.3 13.35 3.65 17.24A16.9 16.9 0 0 0 8.8 20a12.6 12.6 0 0 0 1.1-1.8 11 11 0 0 1-1.73-.84l.42-.33a12 12 0 0 0 10.82 0l.43.33c-.55.33-1.13.61-1.74.84A12.5 12.5 0 0 0 19.2 20a16.8 16.8 0 0 0 5.15-2.76v-.01c.42-4.5-.7-8.42-2.9-11.87ZM9.4 14.86c-1.02 0-1.86-.94-1.86-2.1 0-1.15.82-2.1 1.86-2.1s1.88.95 1.86 2.1c0 1.16-.82 2.1-1.86 2.1Zm5.2 0c-1.02 0-1.86-.94-1.86-2.1 0-1.15.82-2.1 1.86-2.1s1.87.95 1.85 2.1c0 1.16-.81 2.1-1.85 2.1Z" />
    </svg>
  );
}

function WebchatGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 3.6 9A14 14 0 0 1 12 21a14 14 0 0 1-3.6-9A14 14 0 0 1 12 3Z" />
    </svg>
  );
}

function LinkedInGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M20.45 2H3.55A1.54 1.54 0 0 0 2 3.52v16.96A1.54 1.54 0 0 0 3.55 22h16.9A1.54 1.54 0 0 0 22 20.48V3.52A1.54 1.54 0 0 0 20.45 2ZM8.08 18.74H5.15V9.5h2.93v9.24Zm-1.47-10.5a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Zm12.24 10.5h-2.93v-4.5c0-1.07-.02-2.45-1.5-2.45-1.5 0-1.73 1.17-1.73 2.37v4.58H9.77V9.5h2.8v1.27h.04a3.08 3.08 0 0 1 2.77-1.52c2.96 0 3.51 1.95 3.51 4.49v5Z" />
    </svg>
  );
}

function EmailGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3.5 7.5 7.14 5a2.4 2.4 0 0 0 2.72 0l7.14-5" />
    </svg>
  );
}

/** The glyph a channel with no entry of its own draws with: a speech bubble,
 *  which reads as "a channel" without claiming to be any particular one. */
function GenericChannelGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.7L3 21l1.9-5a8.3 8.3 0 0 1-.8-3.6 8.4 8.4 0 0 1 8.4-8.4h.5a8.4 8.4 0 0 1 8 8Z" />
    </svg>
  );
}

/**
 * A badge names the network a person is reachable on, not the credential Rome
 * reads it through: the guardian's own WeChat client and a WeChat official
 * account are both "WeChat". Which of the two carried a message is a
 * Connections question, and that surface already answers it.
 */
export const CHANNEL_META: Record<string, ChannelMeta> = {
  whatsapp: { labelKey: "channels.whatsapp", Glyph: WhatsAppGlyph },
  telegram: { labelKey: "channels.telegram", Glyph: TelegramGlyph },
  telegram_user: { labelKey: "channels.telegram", Glyph: TelegramGlyph },
  discord: { labelKey: "channels.discord", Glyph: DiscordGlyph },
  webchat: { labelKey: "channels.webchat", Glyph: WebchatGlyph },
  linkedin: { labelKey: "channels.linkedin", Glyph: LinkedInGlyph },
  wechat: { labelKey: "channels.wechat", Glyph: WeChatIcon },
  wechat_user: { labelKey: "channels.wechat", Glyph: WeChatIcon },
  email: { labelKey: "channels.email", Glyph: EmailGlyph },
  feishu: { labelKey: "channels.feishu" },
};

/**
 * What a channel is called in front of a person.
 *
 * A channel Rome has no entry for is the branch every channel added after this
 * page was written lands in — a Rome App's above all — and its name there is an
 * id, written for code. Spell it the way a person writes a name: `city_lights`
 * reads "City Lights". An internal name never reaches the page.
 */
export function channelLabel(t: TFunction<"people">, channel: string): string {
  const meta = CHANNEL_META[channel];
  return meta ? t(meta.labelKey) : humanizeChannel(channel);
}

/** Which separator an id spells its words with is the channel's own business —
 *  a channel name is any string without a colon — so every run of characters
 *  that is neither a letter nor a digit is one. An id holding no letter or
 *  digit at all has no name in it to title, and stands as it is: a badge
 *  reading nothing says less than one reading the id. */
function humanizeChannel(channel: string): string {
  const words = channel
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(" ") : channel;
}

export function ChannelGlyph({ channel, className }: { channel: string; className?: string }) {
  const Glyph = CHANNEL_META[channel]?.Glyph ?? GenericChannelGlyph;
  return <Glyph className={cn("size-4 shrink-0", className)} />;
}

/**
 * Glyph plus channel name, for the places that name the channel outright: an
 * unplaced account's row, a linked account, a timeline entry.
 *
 * The kit's `Badge`, not a pill written here — the design note's specimens are
 * drawn with the primitives the page ships with, so a hand-rolled pill beside
 * them is a second answer to what a badge looks like. The glyph goes in bare:
 * `Badge` sizes an `<svg>` that carries no `size-*` of its own, and a size
 * written here would opt out of that rule.
 */
export function ChannelPill({
  channel,
  children,
}: {
  channel: string;
  /** What the pill says after its glyph. The channel's own name when omitted. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation("people");
  const Glyph = CHANNEL_META[channel]?.Glyph ?? GenericChannelGlyph;
  return (
    <Badge variant="outline" className="shrink-0 text-muted-foreground">
      <Glyph />
      {children ?? channelLabel(t, channel)}
    </Badge>
  );
}
