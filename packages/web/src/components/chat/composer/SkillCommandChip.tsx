import { useTranslation } from "react-i18next";
import { RomeLogo } from "@/components/logo";
import { artifactLocalName } from "@/lib/artifact-name";
import { ComposerChip } from "./ComposerChip";

/** The composer's structured skill selection. Only the name is
 * load-bearing — description feeds the tooltip when we have it, iconUrl the
 * owning app's icon (absent falls back to the Rome mark). */
export interface SkillSelection {
  name: string;
  localName?: string;
  description?: string;
  iconUrl?: string | null;
}

export interface SkillCommandChipProps {
  skill: SkillSelection;
  onRemove?: () => void;
}

/**
 * Chip for a picked slash skill, mirroring AgentMentionChip: the selection
 * lives as structured state (sent as the turn's `skillName` field), not as
 * `/<name>` text in the textarea — so skill names that can't be typed as a
 * single slash token are invocable too.
 */
export function SkillCommandChip({ skill, onRemove }: SkillCommandChipProps) {
  const { t } = useTranslation("chat");
  return (
    <ComposerChip
      prefix="Skill"
      mono
      icon={
        skill.iconUrl ? (
          <img src={skill.iconUrl} alt="" className="size-3.5 shrink-0 rounded-4" />
        ) : (
          <RomeLogo aria-hidden="true" className="size-3.5 shrink-0" />
        )
      }
      title={skill.description || t("slashSkill.chipTitle", { name: skill.name })}
      onRemove={onRemove}
      removeLabel={t("slashSkill.remove")}
    >
      {skill.localName ?? artifactLocalName(skill.name)}
    </ComposerChip>
  );
}
