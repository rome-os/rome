import { ChatBubble } from "@/components/chat/ChatBubble";

/**
 * The guardian's words a voice conversation has heard and not sent yet, at the
 * end of the Concierge transcript. The bubble grows as they speak and stands
 * faint, as nothing is sent; the sent message takes its place once Rome hears
 * the turn end.
 */
export function VoiceHeardBubble({ text }: { text: string }) {
  return (
    <div data-voice-heard className="flex flex-col items-end">
      <div className="max-w-[90%]">
        <ChatBubble tone="sent" className="whitespace-pre-wrap opacity-60">
          {text}
        </ChatBubble>
      </div>
    </div>
  );
}
