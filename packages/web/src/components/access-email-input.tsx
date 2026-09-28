import { useId, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { accountMatchesQuery } from "@rome/api-types/people";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { contactEmailSuggestions, EMAIL_CHANNEL } from "@/lib/contact-emails";
import { parseEmailTextarea } from "@/lib/email-list";
import { isImeCompositionEvent } from "@/lib/keyboard-submit";
import { cn } from "@/lib/utils";
import { useAccountSearch } from "@/pages/people/use-roster";

/**
 * The email field of an access allow-list, completing from the contacts list
 * as the guardian types.
 *
 * Suggestions are an aid, never a gate: Enter still commits whatever was typed,
 * so an address Rome has never seen is as easy to add as before. Only one
 * address at a time is completed — a typed separator means a list is being
 * entered, and the list path owns it.
 */
export function AccessEmailInput({
  id,
  value,
  onChange,
  onCommit,
  onPaste,
  exclude,
  disabled,
  invalid,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Adds `raw` (one address, or the typed text) to the list. */
  onCommit: (raw: string) => void;
  onPaste: (event: ClipboardEvent<HTMLInputElement>) => void;
  /** Addresses already on the list, never offered again. */
  exclude: readonly string[];
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
}) {
  const { t } = useTranslation("apps");
  const listId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const term = value.trim();
  // A space can sit inside a name ("Mira Chen"), so only a comma or semicolon
  // says a list is being typed. A pasted list takes the paste path anyway.
  const searchable = term.length > 0 && !/[,;]/.test(term);
  const search = useAccountSearch(searchable ? term : "", {
    enabled: searchable && !disabled,
    channel: EMAIL_CHANNEL,
  });
  // The page lags the typed term by the debounce, so an answer to an older
  // prefix is narrowed to what is typed now — by the server's own rule for a
  // fixed channel, so the current answer is never cut down to less than the
  // server returned.
  const suggestions = useMemo(() => {
    if (!searchable || !search.data) return [];
    const matching = search.data.accounts.filter((account) =>
      accountMatchesQuery(account, term, { matchChannel: false }),
    );
    return contactEmailSuggestions(matching, { exclude, limit: 6 });
  }, [searchable, search.data, term, exclude]);

  const open = !dismissed && !disabled && suggestions.length > 0;
  const active = open && highlight >= 0 && highlight < suggestions.length ? highlight : -1;

  const pick = (email: string) => {
    onCommit(email);
    setHighlight(-1);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(true);
      }}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef}>
          <Input
            id={id}
            size="md"
            icon={<Mail />}
            // Text, not email: an email field strips its value's surrounding
            // whitespace, which eats the space between two words of a name.
            type="text"
            inputMode="email"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setDismissed(false);
              setHighlight(-1);
            }}
            onKeyDown={(event) => {
              // Keys that drive an input method's candidate list belong to it,
              // Enter included: that Enter confirms a candidate, not the field.
              if (isImeCompositionEvent(event)) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (!open) return;
                event.preventDefault();
                // Positions run none, first … last, and wrap: the typed text
                // is a stop of its own, so Enter can still commit it.
                const step = event.key === "ArrowDown" ? 1 : -1;
                const stops = suggestions.length + 1;
                setHighlight(((active + 1 + step + stops) % stops) - 1);
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              // A typed name is a search, not an address: Enter takes the top
              // match for it. A typed address commits as typed, as it always has.
              const typedEmail = parseEmailTextarea(value).emails.length > 0;
              const chosen = suggestions[active] ?? (typedEmail ? undefined : suggestions[0]);
              if (chosen) pick(chosen.email);
              else onCommit(value);
            }}
            onPaste={onPaste}
            disabled={disabled}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            aria-invalid={invalid ? true : undefined}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-(--radix-popover-trigger-width) gap-0 p-1"
        // Focus stays in the field: the guardian is typing, and the list is
        // driven from it by the arrow keys.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
      >
        <ul id={listId} role="listbox" aria-label={t("installed.accessDialog.contactSuggestions")}>
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.email}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                "flex cursor-pointer flex-col rounded-4 px-2 py-1 text-left",
                index === active ? "bg-surface-muted" : "hover:bg-surface-muted",
              )}
              // Keep focus in the field; a click lands on the option anyway.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => pick(suggestion.email)}
            >
              {suggestion.name ? (
                <>
                  <span className="truncate text-ui text-foreground">{suggestion.name}</span>
                  <span className="truncate text-aux text-muted-foreground">
                    {suggestion.email}
                  </span>
                </>
              ) : (
                <span className="truncate text-ui text-foreground">{suggestion.email}</span>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
