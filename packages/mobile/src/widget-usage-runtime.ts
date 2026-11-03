import * as SecureStore from "expo-secure-store";
import { Image, Platform } from "react-native";
import { IOS_KEYCHAIN_ACCESS_GROUP } from "./config";
import type { CloudInstance, InstanceSession } from "@rome-os/libs/native-auth";
import { createWidgetInstanceSession, parseWidgetInstanceSession } from "./widget-instance-session";
import type { TokenUsageWidgetProps } from "./widget-usage";

const WIDGET_SESSION_KEY = "rome.widget.instance-session.v1";
const LEGACY_WIDGET_SESSION_KEY = "rome.widget.session.v1";
const widgetSessionOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  keychainService: "cc.romeos.mobile.widget-session",
  ...(IOS_KEYCHAIN_ACCESS_GROUP ? { accessGroup: IOS_KEYCHAIN_ACCESS_GROUP } : {}),
};

const widgetAssets =
  Platform.OS === "ios"
    ? {
        codexLogo: Image.resolveAssetSource(require("../assets/widgets/codex.png"))?.uri,
        claudeLogo: Image.resolveAssetSource(require("../assets/widgets/claude.png"))?.uri,
        romeLogo: Image.resolveAssetSource(require("../assets/widgets/rome.png"))?.uri,
      }
    : undefined;

function emptySnapshot(): TokenUsageWidgetProps {
  return {
    schemaVersion: 1,
    state: "empty",
    updatedAt: Date.now(),
    providers: [
      { id: "codex", status: "unavailable", quotaExhausted: false },
      { id: "claude", status: "unavailable", quotaExhausted: false },
    ],
  };
}

async function publishWidgetState(resetSnapshot: boolean): Promise<void> {
  const { default: TokenUsageWidget } = await import("../widgets/TokenUsageWidget");
  const current = await TokenUsageWidget.getTimeline().catch(() => []);
  const entries =
    !resetSnapshot && current.length > 0 ? current : [{ date: new Date(), props: emptySnapshot() }];
  TokenUsageWidget.updateTimeline(
    entries.map((entry) => {
      const { stale: _stale, ...props } = entry.props as TokenUsageWidgetProps & {
        stale?: boolean;
      };
      return {
        ...entry,
        props: {
          ...props,
          ...(widgetAssets ? { assets: widgetAssets } : {}),
        },
      };
    }),
  );
}

let configurationQueue: Promise<void> = Promise.resolve();

export async function configureTokenUsageWidget(
  instance: CloudInstance,
  session: InstanceSession,
): Promise<void> {
  if (Platform.OS !== "ios") return;
  const pending = configurationQueue
    .catch(() => undefined)
    .then(async () => {
      if (session.origin !== instance.origin) {
        throw new Error("Widget session does not belong to the selected instance");
      }
      const credential = createWidgetInstanceSession(session);
      if (!credential) throw new Error("Widget received an invalid instance session");
      const existing = parseWidgetInstanceSession(
        await SecureStore.getItemAsync(WIDGET_SESSION_KEY, widgetSessionOptions),
      );
      const instanceChanged = existing?.origin !== credential.origin;
      await SecureStore.setItemAsync(
        WIDGET_SESSION_KEY,
        JSON.stringify(credential),
        widgetSessionOptions,
      );
      await SecureStore.deleteItemAsync(LEGACY_WIDGET_SESSION_KEY, widgetSessionOptions);
      await publishWidgetState(instanceChanged);
    });
  configurationQueue = pending;
  return pending;
}

export async function disableTokenUsageWidget(): Promise<void> {
  if (Platform.OS !== "ios") return;
  await configurationQueue.catch(() => undefined);
  await SecureStore.deleteItemAsync(WIDGET_SESSION_KEY, widgetSessionOptions);
  await SecureStore.deleteItemAsync(LEGACY_WIDGET_SESSION_KEY, widgetSessionOptions);
  const { default: TokenUsageWidget } = await import("../widgets/TokenUsageWidget");
  TokenUsageWidget.updateSnapshot({
    ...emptySnapshot(),
    state: "auth-required",
    ...(widgetAssets ? { assets: widgetAssets } : {}),
  });
}
