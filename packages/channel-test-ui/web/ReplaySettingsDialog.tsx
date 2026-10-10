import { Button } from "@rome-os/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rome-os/ui/dialog";
import { Input } from "@rome-os/ui/input";
import {
  FormRow,
  FormRowControl,
  FormRowHeading,
  FormRowLabel,
  FormRows,
} from "@rome-os/ui/layout-form";
import { Switch } from "@rome-os/ui/switch";
import { type ReactNode, useId, useState } from "react";
import { REPLAY_LIMITS, type ReplaySettings } from "../src/replay.js";

type NumberKey = keyof typeof REPLAY_LIMITS;

/** One setting: its label, with the control that sets it at the end. */
function SettingRow({
  label,
  htmlFor,
  disabled,
  children,
}: {
  label: string;
  htmlFor: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <FormRow>
      <FormRowHeading>
        <FormRowLabel htmlFor={htmlFor} className={disabled ? "text-muted-foreground" : undefined}>
          {label}
        </FormRowLabel>
      </FormRowHeading>
      <FormRowControl>{children}</FormRowControl>
    </FormRow>
  );
}

/**
 * A number field that lets the text be empty or half typed. While the field
 * has focus it shows what was typed. The setting changes whenever the text is
 * a number, and the field shows the setting again when it loses focus.
 */
function NumberField({
  label,
  field,
  settings,
  disabled,
  onChange,
}: {
  label: string;
  field: NumberKey;
  settings: ReplaySettings;
  disabled?: boolean;
  onChange: (next: ReplaySettings) => void;
}) {
  const id = useId();
  const [min, max] = REPLAY_LIMITS[field];
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <SettingRow label={label} htmlFor={id} disabled={disabled}>
      <Input
        id={id}
        type="number"
        size="sm"
        inputMode="numeric"
        className="w-24 text-right"
        min={min}
        max={max}
        disabled={disabled}
        value={draft ?? String(settings[field])}
        onChange={(event) => {
          setDraft(event.target.value);
          const number = event.target.valueAsNumber;
          if (Number.isFinite(number)) onChange({ ...settings, [field]: number });
        }}
        onBlur={() => setDraft(null)}
      />
    </SettingRow>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingRow label={label} htmlFor={id} disabled={disabled}>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </SettingRow>
  );
}

/**
 * The replay settings in a modal dialog. A change applies at once, so there is
 * nothing to confirm: Done only closes it.
 */
export function ReplaySettingsDialog({
  open,
  onClose,
  settings,
  onChange,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  settings: ReplaySettings;
  onChange: (next: ReplaySettings) => void;
  onReset: () => void;
}) {
  const typing = settings.typewriter;
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DialogHeader onClose={onClose}>
        <DialogTitle>Replay settings</DialogTitle>
        <DialogDescription>A change applies at once and stays in this browser.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FormRows>
          <NumberField
            label="Pause before a message (ms)"
            field="messageDelayMs"
            settings={settings}
            onChange={onChange}
          />
          <NumberField
            label="Pause before an edit (ms)"
            field="editDelayMs"
            settings={settings}
            onChange={onChange}
          />
          <Toggle
            label="Typewriter effect"
            checked={typing}
            onChange={(typewriter) => onChange({ ...settings, typewriter })}
          />
          <NumberField
            label="Typing speed (characters per second)"
            field="charsPerSecond"
            settings={settings}
            disabled={!typing}
            onChange={onChange}
          />
          <NumberField
            label="Longest typing time per message (ms)"
            field="maxTypingMs"
            settings={settings}
            disabled={!typing}
            onChange={onChange}
          />
          <Toggle
            label="Also type the user's messages"
            checked={settings.typeUserMessages}
            disabled={!typing}
            onChange={(typeUserMessages) => onChange({ ...settings, typeUserMessages })}
          />
        </FormRows>
      </DialogBody>
      <DialogFooter className="justify-between">
        <Button variant="outline" onClick={onReset}>
          Reset to defaults
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </Dialog>
  );
}
