import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { SkillSelection } from "./SkillCommandChip";
import type { SlashSkillMenuHandle } from "./SlashSkillMenu";

/** Shared slash detection, selection and keyboard navigation for chat composers. */
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
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const slashMenuRef = useRef<SlashSkillMenuHandle>(null);

  const reevaluateSlashContext = useCallback(
    (value: string, cursor: number) => {
      const token = value.slice(1, cursor);
      const slashCount = token.split("/").length - 1;
      // Scoped app ids allow one internal slash; file paths are not skill queries.
      const slashShapeAllowed = slashCount === 0 || (token.startsWith("@") && slashCount === 1);
      if (
        enabled &&
        value.startsWith("/") &&
        cursor >= 1 &&
        !/\s/.test(token) &&
        slashShapeAllowed
      ) {
        setSlashQuery(token);
        setSlashMenuOpen(true);
        return;
      }
      if (slashMenuOpen) {
        setSlashMenuOpen(false);
        setSlashQuery("");
      }
    },
    [slashMenuOpen, enabled],
  );

  const acceptSlashSkill = useCallback(
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
      setSlashMenuOpen(false);
      setSlashQuery("");
    },
    [inputText, setInputText, setDraftSkill, textareaRef, uploadInFlightRef],
  );

  const handleSlashKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (slashMenuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashMenuRef.current?.move(1);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashMenuRef.current?.move(-1);
        return true;
      }
      // Horizontal navigation mirrors the mention menu: the slash menu is the
      // same two-panel app → item picker, so ArrowRight drills into the
      // skills panel and ArrowLeft returns to apps instead of moving the
      // textarea cursor.
      if (e.key === "ArrowRight") {
        e.preventDefault();
        slashMenuRef.current?.moveHorizontal(1);
        return true;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        slashMenuRef.current?.moveHorizontal(-1);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        if (slashMenuRef.current?.acceptSelected()) {
          e.preventDefault();
          return true;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        setSlashQuery("");
        return true;
      }
    }
    return false;
  };

  return {
    slashMenuOpen,
    setSlashMenuOpen,
    slashQuery,
    setSlashQuery,
    slashMenuRef,
    reevaluateSlashContext,
    acceptSlashSkill,
    handleSlashKeyDown,
  };
}
