import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { InputOTP, InputOTPGroup, InputOTPSlot, REGEXP_ONLY_DIGITS } from "./input-otp.js";

afterEach(cleanup);

function renderOtp(
  props: {
    size?: "sm" | "md";
    masked?: boolean;
    invalid?: boolean;
    value?: string;
    onChange?: (value: string) => void;
  } = {},
) {
  return render(
    <InputOTP
      maxLength={4}
      pattern={REGEXP_ONLY_DIGITS}
      aria-label="Code"
      value={props.value ?? ""}
      onChange={props.onChange ?? (() => {})}
    >
      <InputOTPGroup>
        {[0, 1, 2, 3].map((index) => (
          <InputOTPSlot
            key={index}
            index={index}
            size={props.size}
            masked={props.masked}
            invalid={props.invalid}
          />
        ))}
      </InputOTPGroup>
    </InputOTP>,
  );
}

const slotsOf = (container: HTMLElement) => [
  ...container.querySelectorAll('[data-slot="input-otp-slot"]'),
];

describe("InputOTP", () => {
  it("draws separate tall slots with the control radius and a fixed border width", () => {
    const sm = renderOtp({ size: "sm" });
    const [small] = slotsOf(sm.container);
    expect(small.classList).toContain("h-[var(--rome-size-44)]");
    expect(small.classList).toContain("w-[var(--rome-size-36)]");
    expect(small.classList).toContain("rounded-[var(--control-r-sm)]");
    expect(small.classList).toContain("border");
    cleanup();

    const md = renderOtp();
    const [medium] = slotsOf(md.container);
    expect(medium.classList).toContain("w-[var(--rome-size-44)]");
    expect(medium.classList).toContain("rounded-[var(--control-r-md)]");
    expect(md.container.querySelector('[data-slot="input-otp-group"]')?.classList).toContain(
      "gap-2",
    );
  });

  it("draws the focus edge the way Input does and a thin invalid edge", () => {
    const { container } = renderOtp();
    const [slot] = slotsOf(container);
    for (const token of [
      "data-[active=true]:outline-solid",
      "data-[active=true]:outline-ring/50",
      "aria-invalid:outline-solid",
      "aria-invalid:outline-destructive/60",
    ]) {
      expect(slot.classList).toContain(token);
    }
  });

  it("marks an invalid slot with aria-invalid, and only then", () => {
    const valid = renderOtp();
    expect(slotsOf(valid.container).every((slot) => !slot.hasAttribute("aria-invalid"))).toBe(true);
    cleanup();
    const invalid = renderOtp({ invalid: true });
    expect(slotsOf(invalid.container).every((slot) => slot.getAttribute("aria-invalid"))).toBe(
      true,
    );
  });

  it("marks a filled slot, so the row shows its progress", () => {
    const { container } = renderOtp({ value: "12" });
    expect(slotsOf(container).map((slot) => slot.getAttribute("data-filled"))).toEqual([
      "true",
      "true",
      "false",
      "false",
    ]);
  });

  it("passes the label and digit-only typing through to the input", async () => {
    const onChange = rs.fn();
    renderOtp({ onChange });
    await userEvent.type(screen.getByLabelText("Code"), "1a2");
    expect(onChange.mock.calls.map(([value]) => value)).toEqual(["1", "2"]);
  });

  it("draws a filled circle in place of a masked character, and the digit otherwise", () => {
    const masked = renderOtp({ value: "12", masked: true });
    expect(masked.container.querySelectorAll('[data-slot="input-otp-dot"]')).toHaveLength(2);
    expect(slotsOf(masked.container)[0].textContent).toBe("");
    cleanup();
    const plain = renderOtp({ value: "12" });
    expect(plain.container.querySelector('[data-slot="input-otp-dot"]')).toBeNull();
    expect(slotsOf(plain.container)[0].textContent).toBe("1");
  });
});
