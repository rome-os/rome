import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { signInToRomeCloud } from "./src/cloud-login";
import { MOBILE_OAUTH_CLIENT_ID, MOBILE_OAUTH_REDIRECT_URI, ROME_CLOUD_ORIGIN } from "./src/config";
import { credentialVault } from "./src/credential-vault-runtime";
import { InstanceWebViewScreen } from "./src/instance-web-view-screen";
import {
  ErrorScreen,
  InstancePickerScreen,
  LoadingScreen,
  SignedOutScreen,
} from "./src/launcher-screens";
import { cloudApi, nativeFetch, sessionCoordinator } from "./src/mobile-runtime";
import { logoutNativeSession, retryPendingCloudRevocation } from "./src/native-logout";
import {
  type CloudCredential,
  type CloudInstance,
  type InstanceSession,
  NativeAuthError,
} from "@rome-os/libs/native-auth";
import { RomeApiClient } from "./src/rome-api-client";
import {
  clearSelectedInstance,
  loadSelectedInstance,
  saveSelectedInstance,
} from "./src/selected-instance-store";
import { webViewCookieStore } from "./src/webview-cookie-store";
import { disableTokenUsageWidget } from "./src/widget-usage-runtime";

type Stage =
  | { kind: "booting" }
  | { kind: "signed_out" }
  | { kind: "authenticating" }
  | { kind: "loading_instances" }
  | { kind: "selecting_instance"; instances: CloudInstance[] }
  | { kind: "creating_session"; instance: CloudInstance; instances: CloudInstance[] }
  | {
      kind: "ready";
      instance: CloudInstance;
      session: InstanceSession;
      instances: CloudInstance[];
    }
  | { kind: "error"; message: string; hasCloudCredential: boolean };

function safeMessage(error: unknown): string {
  if (error instanceof NativeAuthError) return error.message;
  return "Rome could not finish that request. Check the network and try again.";
}

export default function App() {
  const [stage, setStage] = useState<Stage>({ kind: "booting" });

  const showInstances = useCallback(async (credential: CloudCredential, resume: boolean) => {
    setStage({ kind: "loading_instances" });
    try {
      const instances = await cloudApi.listInstances(credential);
      if (resume) {
        const remembered = await loadSelectedInstance(AsyncStorage, ROME_CLOUD_ORIGIN);
        const selected = remembered
          ? instances.find(
              (instance) =>
                instance.id === remembered.id &&
                instance.origin === remembered.origin &&
                instance.status === "running",
            )
          : null;
        if (selected) {
          const session = await sessionCoordinator.restore(selected);
          const apiClient = new RomeApiClient(
            selected,
            credentialVault,
            sessionCoordinator,
            nativeFetch,
          );
          const verified = await apiClient.request("/api/auth/verify");
          if (verified.status !== 204) throw new Error("session verification failed");
          setStage({ kind: "ready", instance: selected, session, instances });
          return;
        }
      }
      setStage({ kind: "selecting_instance", instances });
    } catch (error) {
      if (error instanceof NativeAuthError && error.code === "cloud_unauthorized") {
        await credentialVault.clearCloudCredential();
        await disableTokenUsageWidget().catch(() => undefined);
        setStage({ kind: "signed_out" });
        return;
      }
      setStage({ kind: "error", message: safeMessage(error), hasCloudCredential: true });
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      await retryPendingCloudRevocation(cloudApi, credentialVault);
      const credential = await credentialVault.getCloudCredential();
      if (!active) return;
      if (!credential) {
        await disableTokenUsageWidget().catch(() => undefined);
        setStage({ kind: "signed_out" });
        return;
      }
      const remembered = await loadSelectedInstance(AsyncStorage, ROME_CLOUD_ORIGIN);
      if (remembered) {
        try {
          const session = await sessionCoordinator.restore(remembered);
          const apiClient = new RomeApiClient(
            remembered,
            credentialVault,
            sessionCoordinator,
            nativeFetch,
          );
          const verified = await apiClient.request("/api/auth/verify");
          if (verified.status === 204) {
            setStage({
              kind: "ready",
              instance: remembered,
              session,
              instances: [remembered],
            });
            return;
          }
        } catch (error) {
          if (error instanceof NativeAuthError && error.code === "cloud_unauthorized") {
            await credentialVault.clearCloudCredential();
            await disableTokenUsageWidget().catch(() => undefined);
            setStage({ kind: "signed_out" });
            return;
          }
        }
      }
      void showInstances(credential, true);
    })();
    return () => {
      active = false;
    };
  }, [showInstances]);

  const signIn = useCallback(async () => {
    setStage({ kind: "authenticating" });
    try {
      const credential = await signInToRomeCloud({
        cloudOrigin: ROME_CLOUD_ORIGIN,
        clientId: MOBILE_OAUTH_CLIENT_ID,
        redirectUri: MOBILE_OAUTH_REDIRECT_URI,
        fetchImpl: nativeFetch,
      });
      await credentialVault.setCloudCredential(credential);
      await showInstances(credential, false);
    } catch (error) {
      setStage({ kind: "error", message: safeMessage(error), hasCloudCredential: false });
    }
  }, [showInstances]);

  const selectInstance = useCallback(
    async (instance: CloudInstance, instances: CloudInstance[]) => {
      setStage({ kind: "creating_session", instance, instances });
      try {
        const session = await sessionCoordinator.refresh(instance);
        await saveSelectedInstance(AsyncStorage, ROME_CLOUD_ORIGIN, instance);
        setStage({ kind: "ready", instance, session, instances });
      } catch (error) {
        if (error instanceof NativeAuthError && error.code === "cloud_unauthorized") {
          await credentialVault.clearCloudCredential();
          await disableTokenUsageWidget().catch(() => undefined);
          setStage({ kind: "signed_out" });
          return;
        }
        if (error instanceof NativeAuthError && error.code === "access_denied") {
          const credential = await credentialVault.getCloudCredential();
          if (credential) await showInstances(credential, false);
          else setStage({ kind: "signed_out" });
          return;
        }
        setStage({ kind: "error", message: safeMessage(error), hasCloudCredential: true });
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    await disableTokenUsageWidget().catch(() => undefined);
    await logoutNativeSession({
      cloudApi,
      vault: credentialVault,
      cookieStore: webViewCookieStore,
      clearSelection: () => clearSelectedInstance(AsyncStorage),
    });
    setStage({ kind: "signed_out" });
  }, []);

  if (stage.kind === "ready") {
    return (
      <InstanceWebViewScreen
        instance={stage.instance}
        session={stage.session}
        onSession={(session) => setStage({ ...stage, session })}
        onFailure={(error) =>
          setStage({ kind: "error", message: safeMessage(error), hasCloudCredential: true })
        }
      />
    );
  }

  if (stage.kind === "signed_out") {
    return <SignedOutScreen onSignIn={() => void signIn()} />;
  }

  if (stage.kind === "selecting_instance") {
    return (
      <InstancePickerScreen
        instances={stage.instances}
        onSelect={(instance) => void selectInstance(instance, stage.instances)}
        onSignOut={() => void logout()}
      />
    );
  }

  if (stage.kind === "error") {
    return (
      <ErrorScreen
        message={stage.message}
        onRetry={() => {
          if (stage.hasCloudCredential) {
            void credentialVault.getCloudCredential().then((credential) => {
              if (credential) void showInstances(credential, true);
              else setStage({ kind: "signed_out" });
            });
          } else {
            void signIn();
          }
        }}
        onSignOut={stage.hasCloudCredential ? () => void logout() : undefined}
      />
    );
  }

  const detail =
    stage.kind === "authenticating"
      ? "Signing in"
      : stage.kind === "creating_session"
        ? `Opening ${stage.instance.name}`
        : stage.kind === "loading_instances"
          ? "Loading services"
          : "Opening Rome";
  return <LoadingScreen detail={detail} />;
}
