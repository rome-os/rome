import { useState } from "react";
import { REPLAY_LIMITS, type ReplaySettings } from "../src/replay.js";

type NumberKey = keyof typeof REPLAY_LIMITS;

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
  const [min, max] = REPLAY_LIMITS[field];
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="setting">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
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
    </label>
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
  return (
    <label className="setting setting-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** The controls for how a replay paces a conversation. */
export function ReplaySettingsPanel({
  id,
  settings,
  onChange,
  onReset,
}: {
  id: string;
  settings: ReplaySettings;
  onChange: (next: ReplaySettings) => void;
  onReset: () => void;
}) {
  const typing = settings.typewriter;
  return (
    <fieldset className="replay-settings" id={id}>
      <legend className="visually-hidden">Replay settings</legend>
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
      <button type="button" className="button" onClick={onReset}>
        Reset to defaults
      </button>
    </fieldset>
  );
}
