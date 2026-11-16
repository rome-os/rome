import { useCallback } from "react";
import type { RefObject } from "react";
import type { SkillSelection } from "./SkillCommandChip";
import { findSkillToken, useTokenPicker } from "./use-token-picker";

/** The `/` skill picker shared by chat composers. Accepting a skill makes it the draft's chip. */
export function useSlashSkill({
  inputText,
  setInputText,
  setDraftSkill,
  textareaRef,
  uploadInFlightRef,
  enabled = true,
}: {
  inputText: string;
  setInputText: (text: string) => void;
  setDraftSkill: (skill: SkillSelection | null) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  uploadInFlightRef: RefObject<boolean>;
  enabled?: boolean;
}) {
  const picker = useTokenPicker({ findToken: findSkillToken, enabled, acceptOnTab: true });
  const { close } = picker;

  const accept = useCallback(
    (skill: SkillSelection) => {
      if (uploadInFlightRef.current) return;
      const cursor = textareaRef.current?.selectionEnd ?? inputText.length;
      setInputText(inputText.slice(cursor).replace(/^\s+/, ""));
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(0, 0);
      });
      setDraftSkill({
        name: skill.name,
        localName: skill.localName,
        description: skill.description,
        iconUrl: skill.iconUrl,
      });
      close();
    },
    [inputText, setInputText, setDraftSkill, textareaRef, uploadInFlightRef, close],
  );

  return { ...picker, accept };
}
