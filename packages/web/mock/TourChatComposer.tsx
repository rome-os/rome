import { forwardRef, useCallback, useRef } from "react";
import {
  ChatComposer as DashboardComposer,
  type ChatComposerHandle,
  type ChatComposerProps,
} from "../src/components/chat/ChatComposer.js";
import { useTourTyping } from "./use-tour-typing";

export * from "../src/components/chat/ChatComposer.js";

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(
  function TourChatComposer(props, forwardedRef) {
    const composer = useRef<ChatComposerHandle | null>(null);
    const attach = useCallback(
      (handle: ChatComposerHandle | null) => {
        composer.current = handle;
        if (typeof forwardedRef === "function") forwardedRef(handle);
        else if (forwardedRef) forwardedRef.current = handle;
      },
      [forwardedRef],
    );
    const insert = useCallback((text: string) => {
      composer.current?.insertText(text, { focus: false });
    }, []);
    useTourTyping(insert);
    return <DashboardComposer {...props} ref={attach} />;
  },
);
