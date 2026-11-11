import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { ROLL } from "@/lib/motion";

function RollValue({ value }: { value: string }) {
  const present = useIsPresent();
  return (
    <motion.span
      // The outgoing value stays on screen for the exit, so only the current
      // one is exposed to a screen reader.
      aria-hidden={present ? undefined : true}
      className="col-start-1 row-start-1"
      initial={{ y: "100%", opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: "-100%", opacity: 0 }}
      transition={ROLL}
    >
      {value}
    </motion.span>
  );
}

/** A word or number that rolls when it changes, and renders still on mount. */
export function Roll({ value }: { value: string }) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion) return <>{value}</>;
  return (
    <span className="inline-grid justify-items-end overflow-hidden align-bottom">
      <AnimatePresence initial={false}>
        <RollValue key={value} value={value} />
      </AnimatePresence>
    </span>
  );
}
