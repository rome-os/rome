// PROTOTYPE ONLY. The variant switcher and the scenario panel. Deliberately
// styled unlike the dashboard (dashed magenta, monospace) so nobody mistakes it
// for the design.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import {
  type Knobs,
  type ProtoState,
  finishTask,
  idleCapReached,
  reset,
  sendThenTestsFinish,
  sendUserMessage,
  setKnob,
  testsFinishThenSend,
} from "./store";

export const VARIANTS = [
  { key: "A", name: "Composer tray" },
  { key: "B", name: "Header indicator + popover" },
  { key: "C", name: "Inline cards in the transcript" },
] as const;
export type VariantKey = (typeof VARIANTS)[number]["key"];

export function useVariant(): VariantKey {
  const [params] = useSearchParams();
  const v = params.get("variant");
  return VARIANTS.some((x) => x.key === v) ? (v as VariantKey) : "A";
}

const chrome: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  background: "#1d1024",
  color: "#f7e6ff",
  border: "2px dashed #e040fb",
  borderRadius: 8,
  zIndex: 2147483000,
  position: "fixed",
};

function PButton({
  onClick,
  children,
  active,
}: {
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "3px 6px",
        margin: "2px 0",
        borderRadius: 4,
        background: active ? "#e040fb" : "#3a1f47",
        color: active ? "#1d1024" : "#f7e6ff",
        border: "none",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Knob<K extends keyof Knobs>({
  label,
  k,
  options,
  proto,
}: {
  label: string;
  k: K;
  options: { value: Knobs[K]; label: string }[];
  proto: ProtoState;
}) {
  return (
    <div style={{ margin: "6px 0" }}>
      <div style={{ opacity: 0.75 }}>{label}</div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => (
          <div key={String(o.value)} style={{ flex: 1 }}>
            <PButton active={proto.knobs[k] === o.value} onClick={() => setKnob(k, o.value)}>
              {o.label}
            </PButton>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PrototypeChrome({ proto }: { proto: ProtoState }) {
  const [params, setParams] = useSearchParams();
  const variant = useVariant();
  const [panelOpen, setPanelOpen] = useState(true);
  const index = VARIANTS.findIndex((v) => v.key === variant);
  const go = (delta: number) => {
    const next = VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length]!;
    const copy = new URLSearchParams(params);
    copy.set("variant", next.key);
    setParams(copy, { replace: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)))
        return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const tests = proto.tasks.find((t) => t.id === "b7i8swnzp");
  const summary = {
    variant: `${variant} · ${VARIANTS[index]!.name}`,
    turn: proto.turn,
    queuedResults: proto.queuedResults,
    queuedUserMessages: proto.queuedUserMessages.length,
    tasks: proto.tasks.map(
      (t) => `${t.id} ${t.label}: ${t.status}${t.reported ? " (reported)" : ""}`,
    ),
    knobs: proto.knobs,
  };

  return createPortal(
    <>
      <div
        style={{
          ...chrome,
          bottom: 4,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 8px",
        }}
      >
        <button
          type="button"
          onClick={() => go(-1)}
          style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}
        >
          ◀
        </button>
        <span>
          PROTOTYPE variant {variant}: {VARIANTS[index]!.name} ({index + 1}/{VARIANTS.length}) · ←/→
        </span>
        <button
          type="button"
          onClick={() => go(1)}
          style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}
        >
          ▶
        </button>
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          style={{ background: "none", border: "none", color: "#e040fb", cursor: "pointer" }}
        >
          {panelOpen ? "hide panel" : "scenarios"}
        </button>
      </div>
      {panelOpen ? (
        <div
          style={{
            ...chrome,
            top: 60,
            right: 8,
            width: 300,
            maxHeight: "calc(100vh - 110px)",
            overflowY: "auto",
            padding: 8,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>PROTOTYPE · background tasks</div>
          <div style={{ opacity: 0.75 }}>Scenarios</div>
          <PButton onClick={() => finishTask("b7i8swnzp", true)}>
            Tests pass (while idle){tests?.status !== "running" ? " — already done" : ""}
          </PButton>
          <PButton onClick={() => finishTask("b7i8swnzp", false)}>Tests fail (while idle)</PButton>
          <PButton onClick={() => finishTask("ad29225d38f3", true)}>Subagent finishes</PButton>
          <PButton onClick={() => finishTask("bq9qakwdi", true)}>
            Preview server exits cleanly
          </PButton>
          <PButton onClick={() => sendThenTestsFinish()}>
            You send a message, tests finish mid-reply
          </PButton>
          <PButton onClick={() => testsFinishThenSend()}>
            Tests finish, you send a message mid-report
          </PButton>
          <PButton onClick={() => sendUserMessage("Is the preview server still up?")}>
            You send a message
          </PButton>
          <PButton onClick={() => idleCapReached()}>
            Idle cap reached ({proto.knobs.idleCap})
          </PButton>
          <PButton onClick={() => reset()}>Reset</PButton>

          <div style={{ opacity: 0.75, marginTop: 8 }}>Open product questions</div>
          <Knob
            label="Stop button on running tasks"
            k="stopButton"
            proto={proto}
            options={[
              { value: true, label: "with Stop" },
              { value: false, label: "without" },
            ]}
          />
          <Knob
            label="After a finished task with nothing notable"
            k="afterTask"
            proto={proto}
            options={[
              { value: "replies", label: "always replies" },
              { value: "may-stay-silent", label: "may stay silent" },
            ]}
          />
          <Knob
            label="Idle chat keeps tasks alive for"
            k="idleCap"
            proto={proto}
            options={[
              { value: "30 min", label: "30 min" },
              { value: "2 h", label: "2 h" },
            ]}
          />

          <div style={{ opacity: 0.75, marginTop: 8 }}>State</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {JSON.stringify(summary, null, 1)}
          </pre>
          <div style={{ opacity: 0.75, marginTop: 8 }}>Events</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{proto.log.join("\n")}</pre>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
