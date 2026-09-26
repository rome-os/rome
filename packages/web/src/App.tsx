import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import { SlotProvider } from "./components/slot";
import { AuthGate } from "./shell/AuthGate";
import { RomeShellLayout } from "./shell/RomeShellLayout";
import { useHostNavigation } from "./hooks/use-host-navigation";
import { useAppRemixResume } from "./hooks/use-app-remix-resume";
import { useCloudLoginReturn } from "./hooks/use-cloud-login-return";
import FreePage from "./pages/free/FreePage";
import { DEV_ROUTES } from "./pages/dev/dev-routes";

// /chat is the home route and what the first-load trace targets, so FreePage +
// the shell stay eager. Every other route is split into its own chunk so the
// initial bundle for /chat doesn't ship Settings, People, Memory, Apps, etc.
const LoginPage = lazy(() => import("./pages/LoginPage"));
const ConnectPage = lazy(() => import("./pages/ConnectPage"));
const OnboardPage = lazy(() => import("./pages/OnboardPage"));
const CallbackPage = lazy(() => import("./pages/CallbackPage"));
const SharePage = lazy(() => import("./pages/share/SharePage"));
const ActivityPage = lazy(() => import("./pages/ActivityPage"));
const PeoplePage = lazy(() => import("./pages/PeoplePage"));
// The /people redirect lives with the views it forwards to, so the paths are
// written once; it rides their chunk, which is the one about to render anyway.
const PeopleIndexRedirect = lazy(() =>
  import("./pages/PeoplePage").then((m) => ({ default: m.PeopleIndexRedirect })),
);
const PersonDetailPage = lazy(() => import("./pages/PersonDetailPage"));
const PersonLegacyRedirect = lazy(() =>
  import("./pages/PersonDetailPage").then((m) => ({ default: m.PersonLegacyRedirect })),
);
const MemoryPage = lazy(() => import("./pages/MemoryPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const RoutinesPage = lazy(() => import("./pages/RoutinesPage"));
const RoutineDetailPage = lazy(() => import("./pages/RoutineDetailPage"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
const AppsIndexPage = lazy(() => import("./pages/AppsIndexPage"));
const AppDetailPage = lazy(() => import("./pages/AppDetailPage"));
const InboxPage = lazy(() => import("./pages/InboxPage"));
const AppInstallConfirmPage = lazy(() => import("./pages/AppInstallConfirmPage"));
const AppRemixConfirmPage = lazy(() => import("./pages/AppRemixConfirmPage"));
const AppEmbeddedPage = lazy(() => import("./pages/AppEmbeddedPage"));
const AppFullPage = lazy(() => import("./pages/AppFullPage"));
const DesktopPage = lazy(() => import("./pages/DesktopPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const SettingsTabPage = lazy(() => import("./pages/SettingsTabPage"));
const ConnectionDetailPage = lazy(() => import("./pages/ConnectionDetailPage"));
const AppKeysPage = lazy(() => import("./pages/AppKeysPage"));
// Dev-only pages (src/pages/dev/). import.meta.env.DEV is statically false in
// production builds, so the route entries below are dropped AND — because each
// registry entry's lazy() dynamic import is only referenced from inside the
// dead `import.meta.env.DEV` branch — the page chunks are never emitted.
// DEV_ROUTES is the single source of truth shared with the /dev index page:
// add a dev page by adding one entry there, nothing here.
const DevIndexPage = import.meta.env.DEV
  ? lazy(() => import("./pages/dev/DevIndexPage"))
  : () => null;

export default function App() {
  // One root-level bridge turns SDK `navigateRome`/`startChat` events into
  // react-router navigations for every surface (shell, full-mode apps, auth).
  useHostNavigation();
  const resumeRemix = useAppRemixResume();
  const cloudLoginReturn = useCloudLoginReturn();
  // Resume before mounting AuthGate so its login-to-home redirect cannot race us.
  if (resumeRemix) return <Navigate to={resumeRemix} replace />;
  if (cloudLoginReturn) return <Navigate to={cloudLoginReturn} replace />;

  return (
    <SlotProvider>
      <Toaster position="top-right" />
      <Suspense fallback={null}>
        <Routes>
          <Route
            path="/login"
            element={
              <AuthGate>
                <LoginPage />
              </AuthGate>
            }
          />
          <Route
            path="/connect"
            element={
              <AuthGate>
                <ConnectPage />
              </AuthGate>
            }
          />
          <Route
            path="/onboard"
            element={
              <AuthGate>
                <OnboardPage />
              </AuthGate>
            }
          />
          <Route path="/callback" element={<CallbackPage />} />

          {/* Public, login-free shared chat — outside AuthGate (no session). */}
          <Route path="/share/:token" element={<SharePage />} />

          {/* Dev-only /dev index + one route per DEV_ROUTES entry. Whole block
              compiles out of production (import.meta.env.DEV is statically
              false), taking the lazy page chunks with it. */}
          {import.meta.env.DEV && <Route path="/dev" element={<DevIndexPage />} />}
          {import.meta.env.DEV &&
            DEV_ROUTES.map(({ path, Component }) => (
              <Route key={path} path={path} element={<Component />} />
            ))}

          {/* Inbox is a host page, not an embedded app (see HOST_APP_ROUTES in
              lib/auth-routing.ts) — a full-mode link to it must not reach
              AppFullPage, which would 404 probing the nonexistent manifest. */}
          <Route path="/full/apps/inbox/*" element={<Navigate to="/apps/inbox" replace />} />
          {/* Sessions is a host-owned app. show_app addresses it through the
              same /full/apps/:appId/:route shape as installed apps so it can
              be mounted as a workspace tile for background fork processing. */}
          <Route
            path="/full/apps/sessions/*"
            element={
              <AuthGate>
                <SessionsPage />
              </AuthGate>
            }
          />
          <Route
            path="/full/apps/:appId/*"
            element={
              <AuthGate>
                <AppFullPage />
              </AuthGate>
            }
          />

          <Route
            element={
              <AuthGate>
                <RomeShellLayout />
              </AuthGate>
            }
          >
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat/*" element={<FreePage />} />
            <Route path="/activity" element={<ActivityPage />} />
            {/* The two People views are routes, so each is linkable and back
                steps between them. The dossier takes its own segment rather
                than sharing theirs: a person id is a slug of the display name
                the guardian gave them, so `latest` and `directory` are ids they
                can mint, and a static view route would leave such a person
                unreachable. The bare `/people/:personId` forwards, so an
                address a person was already reached by keeps working. */}
            <Route path="/people" element={<PeopleIndexRedirect />} />
            <Route path="/people/latest" element={<PeoplePage view="latest" />} />
            <Route path="/people/directory" element={<PeoplePage view="directory" />} />
            <Route path="/people/person/:personId" element={<PersonDetailPage />} />
            <Route path="/people/:personId" element={<PersonLegacyRedirect />} />
            <Route path="/memory/*" element={<MemoryPage />} />
            <Route path="/projects/*" element={<ProjectsPage />} />
            <Route path="/sessions/*" element={<SessionsPage />} />
            <Route path="/routines" element={<RoutinesPage />} />
            <Route path="/routines/:id" element={<RoutineDetailPage />} />
            <Route path="/events" element={<Navigate to="/routines" replace />} />
            <Route path="/apps" element={<AppsIndexPage />} />
            <Route path="/install-app/:handle" element={<AppInstallConfirmPage />} />
            <Route path="/install-app/:handle/:slug" element={<AppInstallConfirmPage />} />
            <Route path="/remix-app" element={<AppRemixConfirmPage />} />
            {/* Static routes win over the dynamic /apps/:appId embed route in
                react-router's ranking, so inbox links open this host page
                instead of the (non-existent) embedded app frontend. Deep links
                under /apps/inbox/* collapse onto the dashboard. */}
            <Route path="/apps/inbox" element={<InboxPage />} />
            <Route path="/apps/inbox/*" element={<Navigate to="/apps/inbox" replace />} />
            {/* Deliberately OUTSIDE /apps/:appId/* — AuthGate classifies
                /apps/<segment> via getRoutedAppId, so a details route in that
                namespace would be treated as embedded app "detail" (public-app
                visitor exemptions could then apply to this guardian-only host
                page, and a real app with id "detail" would be shadowed). */}
            <Route path="/app-details/:appId" element={<AppDetailPage />} />
            <Route path="/apps/:appId/*" element={<AppEmbeddedPage />} />
            <Route path="/desktop" element={<DesktopPage />} />
            {/* Guide merged into the Showcases app; keep the old path working. */}
            <Route path="/guide" element={<Navigate to="/apps/showcases" replace />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* More-specific static-segment path must win over the wildcard
                `:tab` route: `/settings/connections` (no id) still falls through
                to SettingsTabPage. */}
            {/* Static segment outranks `:serviceId`, so "app-keys" never
                reaches ConnectionDetailPage's unknown-id redirect. */}
            <Route path="/settings/connections/app-keys" element={<AppKeysPage />} />
            <Route path="/settings/connections/:serviceId" element={<ConnectionDetailPage />} />
            <Route path="/settings/:tab" element={<SettingsTabPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </SlotProvider>
  );
}
