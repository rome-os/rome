import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Keyboard,
  Linking,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";
import { keyboardOverlap } from "./keyboard-inset";
import { LauncherMessage } from "./launcher-screens";
import { EMBER } from "./mobile-theme";
import { sessionCoordinator } from "./mobile-runtime";
import type { CloudInstance, InstanceSession } from "./native-auth-types";
import { configureTokenUsageWidget } from "./widget-usage-runtime";

interface InstanceWebViewScreenProps {
  instance: CloudInstance;
  session: InstanceSession;
  onSession(session: InstanceSession): void;
  onFailure(error: unknown): void;
}

function RefreshingBanner() {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-6)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        duration: 140,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        duration: 180,
        easing: Easing.out(Easing.cubic),
        toValue: 0,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <Animated.View style={[styles.refreshing, { opacity, transform: [{ translateY }] }]}>
      <ActivityIndicator color={EMBER.primary} />
      <Text style={styles.refreshingLabel}>Reconnecting</Text>
    </Animated.View>
  );
}

// The dp of `shell` the Android keyboard covers, so the WebView can end at the
// keyboard's top edge (keyboard-inset.ts). Always zero on iOS, where WKWebView
// reports the keyboard to the page through its visual viewport and the
// dashboard lays itself out above it.
function useAndroidKeyboardInset(shell: RefObject<View | null>): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      const keyboardTop = event.endCoordinates.screenY;
      shell.current?.measureInWindow((_x, y, _width, height) => {
        setInset(keyboardOverlap({ y, height }, keyboardTop));
      });
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [shell]);

  return inset;
}

export function InstanceWebViewScreen({
  instance,
  session,
  onSession,
  onFailure,
}: InstanceWebViewScreenProps) {
  const webViewRef = useRef<WebView>(null);
  const shellRef = useRef<View>(null);
  const keyboardInset = useAndroidKeyboardInset(shellRef);
  const [webViewKey, setWebViewKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await sessionCoordinator.refresh(instance);
      onSession(next);
      setWebViewKey((value) => value + 1);
    } catch (error) {
      onFailure(error);
    } finally {
      setRefreshing(false);
    }
  }, [instance, onFailure, onSession, refreshing]);

  useEffect(() => {
    const configureWidget = () => configureTokenUsageWidget(instance, session);
    void configureWidget().catch((error) => {
      console.warn("[rome-mobile] Widget configuration failed", error);
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void configureWidget().catch((error) => {
        console.warn("[rome-mobile] Widget foreground reload failed", error);
      });
    });
    return () => {
      appState.remove();
    };
  }, [instance, session]);

  const onShouldStartLoadWithRequest = useCallback<
    NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>
  >(
    (request) => {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return false;
      }
      if (url.origin === instance.origin) {
        if (request.isTopFrame && url.pathname === "/login") {
          void refresh();
          return false;
        }
        return true;
      }
      if (request.isTopFrame && url.protocol === "https:") {
        void Linking.openURL(url.toString());
      }
      return false;
    },
    [instance.origin, refresh],
  );

  const onHttpError = useCallback<NonNullable<WebViewProps["onHttpError"]>>(
    (event) => {
      if (event.nativeEvent.statusCode === 401) void refresh();
      else if (event.nativeEvent.statusCode >= 500) onFailure(new Error("instance unavailable"));
    },
    [onFailure, refresh],
  );

  return (
    <View ref={shellRef} style={[styles.shell, { paddingBottom: keyboardInset }]}>
      <View style={styles.webViewContainer}>
        <WebView
          key={webViewKey}
          ref={webViewRef}
          source={{
            uri: instance.origin,
            headers: { Cookie: `${session.cookieName}=${session.token}` },
          }}
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onOpenWindow={(event) => {
            const target = event.nativeEvent.targetUrl;
            try {
              const url = new URL(target);
              if (url.origin === instance.origin) {
                webViewRef.current?.injectJavaScript(
                  `window.location.href=${JSON.stringify(url.toString())};true;`,
                );
              } else if (url.protocol === "https:") {
                void Linking.openURL(url.toString());
              }
            } catch {
              return;
            }
          }}
          onHttpError={onHttpError}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          bounces={false}
          overScrollMode="never"
          // The dashboard's viewport tag already forbids zoom. Android WebView
          // also has zoom gestures of its own, on by default in this library.
          setBuiltInZoomControls={false}
          style={styles.webView}
          renderError={() => (
            <LauncherMessage
              title="Rome is unavailable"
              action="Try again"
              onAction={() => setWebViewKey((value) => value + 1)}
              tone="error"
            />
          )}
        />
        {refreshing ? <RefreshingBanner /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { backgroundColor: EMBER.background, flex: 1 },
  webViewContainer: { backgroundColor: EMBER.background, flex: 1 },
  webView: { backgroundColor: EMBER.background },
  refreshing: {
    alignItems: "center",
    backgroundColor: EMBER.overlaySurface,
    borderColor: EMBER.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 9,
    left: 24,
    paddingHorizontal: 14,
    paddingVertical: 11,
    position: "absolute",
    right: 24,
    top: 14,
  },
  refreshingLabel: { color: EMBER.mutedForeground, fontSize: 13, fontWeight: "600" },
});
