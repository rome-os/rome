import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RevealToggle } from "@/components/reveal-toggle";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  REGEXP_ONLY_DIGITS,
} from "@/components/ui/input-otp";

const PIN_SLOTS = [0, 1, 2, 3, 4, 5];
const SHAKE = [0, -6, 5, -3, 0].map((offset) => ({ transform: `translateX(${offset}px)` }));

/** Counts the errors that arrive, so a repeat of the same message still replays the shake. */
export function useErrorCount(error: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (error) setCount((previous) => previous + 1);
  }, [error]);
  return count;
}

/**
 * The vault PIN as six slots, digits only, masked until the eye is pressed.
 * The sixth digit submits nothing. `invalid` marks the slots, and each change
 * of `shakeKey` plays one short shake unless the guardian prefers less motion.
 */
export function PinInput({
  value,
  onChange,
  size,
  disabled,
  invalid,
  shakeKey,
  id,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (pin: string) => void;
  size?: "sm" | "md";
  disabled?: boolean;
  invalid?: boolean;
  shakeKey?: number;
  id?: string;
  "aria-label"?: string;
}) {
  const { t } = useTranslation("common");
  const [shown, setShown] = useState(false);
  const slots = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = slots.current;
    if (!shakeKey || typeof element?.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(SHAKE, { duration: 300, easing: "ease-in-out" });
  }, [shakeKey]);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <InputOTP
        id={id}
        maxLength={PIN_SLOTS.length}
        pattern={REGEXP_ONLY_DIGITS}
        autoComplete="off"
        aria-label={ariaLabel}
        value={value}
        onChange={onChange}
        disabled={disabled}
        containerClassName="min-w-0"
      >
        <InputOTPGroup ref={slots}>
          {PIN_SLOTS.map((index) => (
            <InputOTPSlot key={index} index={index} size={size} masked={!shown} invalid={invalid} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      <RevealToggle
        shown={shown}
        onToggle={() => setShown((previous) => !previous)}
        showLabel={t("vaultPin.show")}
        hideLabel={t("vaultPin.hide")}
        disabled={disabled}
        className="shrink-0"
      />
    </div>
  );
}
