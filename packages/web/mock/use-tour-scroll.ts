import {
  useStickToBottom as useDashboardScroll,
  type UseStickToBottomOptions,
} from "../src/hooks/use-stick-to-bottom";

export * from "../src/hooks/use-stick-to-bottom";

const stayAtStart = () => {};

export function useStickToBottom(options: UseStickToBottomOptions = {}) {
  const guided = new URLSearchParams(window.location.search).get("tour") === "build";
  const scroll = useDashboardScroll({ ...options, ...(guided ? { initialStuck: false } : {}) });
  return guided ? { ...scroll, scrollToBottom: stayAtStart } : scroll;
}
