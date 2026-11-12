// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryRouter,
  Navigate,
  type NavigateFunction,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useCloudLoginReturn } from "@/hooks/use-cloud-login-return";
import i18n from "@/i18n";
import { MAIN_CHAT_PATH } from "@/lib/chat-session";
import { rememberLoginReturn } from "@/lib/login-return";
import SettingsDialog from "@/pages/SettingsDialog";
import { useSettingsBackdrop } from "./use-settings-backdrop";

rs.mock("@/lib/auth-state", () => ({
  useAuthStateSnapshot: () => ({ bootstrap: { phase: "ready" } }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  signedIn = true;
});

let navigateTo: NavigateFunction;
let signedIn = true;

/** App's shell, cut down: the Cloud sign-in return, the page behind, and Settings. */
function App() {
  const location = useLocation();
  navigateTo = useNavigate();
  const { backdrop, settingsOpen, close } = useSettingsBackdrop();
  const cloudLoginReturn = useCloudLoginReturn();
  if (cloudLoginReturn) return <Navigate to={cloudLoginReturn} replace />;
  return (
    <>
      <output aria-label="location">{location.pathname}</output>
      <Routes location={backdrop}>
        <Route path="/" element={<Navigate to={MAIN_CHAT_PATH} replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Behind />} />
      </Routes>
      {settingsOpen ? (
        <SettingsDialog onClose={close}>
          <p>Section</p>
        </SettingsDialog>
      ) : null}
    </>
  );
}

/** Signed in, AuthGate sends the sign-in page home. */
function Login() {
  return signedIn ? <Navigate to="/" replace /> : <p>Sign in</p>;
}

function Behind() {
  return <output aria-label="behind">{useLocation().pathname}</output>;
}

const read = (label: string) => screen.getByLabelText(label, { hidden: true }).textContent;

function renderApp(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("useSettingsBackdrop", () => {
  it("keeps Settings open when a Cloud sign-in returns to it", async () => {
    rememberLoginReturn("/settings/connections");
    renderApp("/?cloud=success");
    await waitFor(() => expect(read("location")).toBe("/settings/connections"));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(read("behind")).toBe(MAIN_CHAT_PATH);
  });

  it("keeps Settings open when a sign-in returns to it", () => {
    signedIn = false;
    renderApp("/login");
    act(() => {
      signedIn = true;
      navigateTo("/settings/advanced", { replace: true });
    });
    expect(read("location")).toBe("/settings/advanced");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(read("behind")).toBe(MAIN_CHAT_PATH);
  });
});
