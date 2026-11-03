import { ActivityIndicator, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { EMBER } from "./mobile-theme";
import type { CloudInstance } from "@rome-os/libs/native-auth";
import { RomeMark } from "./rome-mark";
import { ScreenEntrance } from "./screen-motion";
import { TactilePressable } from "./tactile-pressable";

interface LauncherMessageProps {
  title: string;
  detail?: string;
  action?: string;
  onAction?: () => void;
  secondaryAction?: string;
  onSecondaryAction?: () => void;
  tone?: "default" | "error";
}

export function LauncherMessage(props: LauncherMessageProps) {
  return (
    <View style={styles.message}>
      <ScreenEntrance style={styles.messageContent}>
        <RomeMark />
        <Text
          style={[
            styles.messageTitle,
            styles.messageTitleSpacing,
            props.tone === "error" && styles.errorTitle,
          ]}
        >
          {props.title}
        </Text>
        {props.detail ? <Text style={styles.messageDetail}>{props.detail}</Text> : null}
        {props.action && props.onAction ? (
          <TactilePressable
            accessibilityRole="button"
            onPress={props.onAction}
            pressedStyle={styles.primaryButtonPressed}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonLabel}>{props.action}</Text>
          </TactilePressable>
        ) : null}
        {props.secondaryAction && props.onSecondaryAction ? (
          <TactilePressable
            accessibilityRole="button"
            onPress={props.onSecondaryAction}
            pressedStyle={styles.secondaryButtonPressed}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonLabel}>{props.secondaryAction}</Text>
          </TactilePressable>
        ) : null}
      </ScreenEntrance>
    </View>
  );
}

export function SignedOutScreen({ onSignIn }: { onSignIn(): void }) {
  return (
    <SafeAreaView style={styles.launcher}>
      <LauncherMessage
        title="Sign in to Rome"
        action="Continue with Rome Cloud"
        onAction={onSignIn}
      />
    </SafeAreaView>
  );
}

interface InstancePickerScreenProps {
  instances: CloudInstance[];
  onSelect(instance: CloudInstance): void;
  onSignOut(): void;
}

export function InstancePickerScreen({
  instances,
  onSelect,
  onSignOut,
}: InstancePickerScreenProps) {
  return (
    <SafeAreaView style={styles.launcher}>
      <ScreenEntrance style={styles.servicesScreen}>
        <ScrollView contentContainerStyle={styles.servicesScroll}>
          <View style={styles.services}>
            <View style={styles.servicesBrand}>
              <RomeMark size={24} />
              <Text style={styles.servicesBrandName}>Rome</Text>
            </View>
            <Text style={styles.servicesTitle}>Choose a Rome</Text>
            {instances.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.empty}>No services available.</Text>
              </View>
            ) : (
              <View style={styles.serviceList}>
                {instances.map((instance, index) => {
                  const available = instance.status === "running";
                  const hostname = instance.origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
                  return (
                    <TactilePressable
                      accessibilityLabel={`${instance.name}, ${available ? "online" : instance.status}`}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !available }}
                      disabled={!available}
                      feedback="selection"
                      key={instance.id}
                      onPress={() => onSelect(instance)}
                      pressedStyle={styles.servicePressed}
                      scaleTo={0.995}
                      style={[
                        styles.service,
                        index > 0 && styles.serviceBorder,
                        !available && styles.serviceDisabled,
                      ]}
                    >
                      <View style={styles.serviceIcon}>
                        <RomeMark size={22} />
                      </View>
                      <View style={styles.serviceCopy}>
                        <Text numberOfLines={1} style={styles.serviceName}>
                          {instance.name}
                        </Text>
                        <View style={styles.serviceMeta}>
                          <View
                            style={[
                              styles.serviceStatusDot,
                              !available && styles.serviceStatusDotUnavailable,
                            ]}
                          />
                          <Text
                            style={[styles.serviceStatus, available && styles.serviceStatusReady]}
                          >
                            {available ? "Online" : instance.status}
                          </Text>
                          <Text style={styles.serviceMetaSeparator}>·</Text>
                          <Text numberOfLines={1} style={styles.serviceHost}>
                            {hostname}
                          </Text>
                        </View>
                      </View>
                      {available ? <Text style={styles.serviceChevron}>›</Text> : null}
                    </TactilePressable>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
        <View style={styles.servicesFooter}>
          <TactilePressable
            accessibilityRole="button"
            onPress={onSignOut}
            pressedStyle={styles.signOutButtonPressed}
            style={styles.signOutButton}
          >
            <Text style={styles.signOutButtonLabel}>Sign out</Text>
          </TactilePressable>
        </View>
      </ScreenEntrance>
    </SafeAreaView>
  );
}

interface ErrorScreenProps {
  message: string;
  onRetry(): void;
  onSignOut?: () => void;
}

export function ErrorScreen({ message, onRetry, onSignOut }: ErrorScreenProps) {
  return (
    <SafeAreaView style={styles.launcher}>
      <LauncherMessage
        title="Couldn't continue"
        detail={message}
        action="Try again"
        onAction={onRetry}
        secondaryAction={onSignOut ? "Sign out" : undefined}
        onSecondaryAction={onSignOut}
        tone="error"
      />
    </SafeAreaView>
  );
}

export function LoadingScreen({ detail }: { detail: string }) {
  return (
    <SafeAreaView style={styles.launcher}>
      <ScreenEntrance style={styles.loading}>
        <RomeMark size={56} />
        <ActivityIndicator color={EMBER.primary} />
        <Text style={styles.loadingLabel}>{detail}</Text>
      </ScreenEntrance>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  launcher: { backgroundColor: EMBER.background, flex: 1 },
  message: {
    backgroundColor: EMBER.background,
    flex: 1,
    justifyContent: "center",
    paddingBottom: 48,
    paddingHorizontal: 24,
  },
  messageContent: { alignSelf: "center", maxWidth: 420, width: "100%" },
  messageTitle: {
    color: EMBER.foreground,
    fontSize: 30,
    fontWeight: "600",
    letterSpacing: -0.8,
  },
  messageTitleSpacing: { marginTop: 20 },
  errorTitle: { color: EMBER.destructiveForeground, fontSize: 28 },
  messageDetail: {
    color: EMBER.mutedForeground,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    maxWidth: 420,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: EMBER.primary,
    borderRadius: 12,
    justifyContent: "center",
    marginTop: 26,
    minHeight: 48,
    paddingHorizontal: 20,
  },
  primaryButtonPressed: { backgroundColor: EMBER.primaryPressed },
  primaryButtonLabel: { color: EMBER.primaryForeground, fontSize: 15, fontWeight: "600" },
  secondaryButton: {
    alignItems: "center",
    borderRadius: 12,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  secondaryButtonPressed: { backgroundColor: EMBER.surfaceHover },
  secondaryButtonLabel: { color: EMBER.mutedForeground, fontSize: 14, fontWeight: "600" },
  loading: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center" },
  loadingLabel: { color: EMBER.mutedForeground, fontSize: 14 },
  servicesScreen: { flex: 1 },
  servicesScroll: { flexGrow: 1, paddingBottom: 24, paddingHorizontal: 20, paddingTop: 16 },
  services: { alignSelf: "center", maxWidth: 560, width: "100%" },
  servicesBrand: { alignItems: "center", flexDirection: "row", gap: 8 },
  servicesBrandName: { color: EMBER.mutedForeground, fontSize: 14, fontWeight: "600" },
  servicesTitle: {
    color: EMBER.foreground,
    fontSize: 28,
    fontWeight: "600",
    letterSpacing: -0.7,
    marginBottom: 20,
    marginTop: 24,
  },
  emptyState: {
    borderTopColor: EMBER.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 20,
  },
  empty: { color: EMBER.mutedForeground, fontSize: 14 },
  serviceList: {
    backgroundColor: EMBER.surfaceElevated,
    borderColor: EMBER.border,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  service: {
    alignItems: "center",
    backgroundColor: EMBER.surfaceElevated,
    flexDirection: "row",
    minHeight: 76,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  serviceBorder: { borderTopColor: EMBER.border, borderTopWidth: StyleSheet.hairlineWidth },
  servicePressed: { backgroundColor: EMBER.surfaceHover },
  serviceDisabled: { opacity: 0.55 },
  serviceIcon: {
    alignItems: "center",
    backgroundColor: EMBER.primaryTint,
    borderRadius: 12,
    height: 44,
    justifyContent: "center",
    marginRight: 12,
    width: 44,
  },
  serviceCopy: { flex: 1, minWidth: 0 },
  serviceName: { color: EMBER.foreground, fontSize: 17, fontWeight: "600" },
  serviceMeta: { alignItems: "center", flexDirection: "row", marginTop: 5 },
  serviceStatusDot: { backgroundColor: EMBER.success, borderRadius: 4, height: 7, width: 7 },
  serviceStatusDotUnavailable: { backgroundColor: EMBER.subtleForeground },
  serviceStatus: {
    color: EMBER.mutedForeground,
    fontSize: 13,
    marginLeft: 6,
    textTransform: "capitalize",
  },
  serviceStatusReady: { color: EMBER.success, fontWeight: "600" },
  serviceMetaSeparator: { color: EMBER.subtleForeground, fontSize: 13, marginHorizontal: 6 },
  serviceHost: { color: EMBER.mutedForeground, flex: 1, fontSize: 13 },
  serviceChevron: {
    color: EMBER.primary,
    fontSize: 28,
    fontWeight: "300",
    lineHeight: 30,
    marginLeft: 12,
  },
  servicesFooter: { paddingHorizontal: 20, paddingVertical: 8 },
  signOutButton: {
    alignItems: "center",
    backgroundColor: EMBER.destructiveForeground,
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 50,
  },
  signOutButtonPressed: { backgroundColor: EMBER.destructivePressed },
  signOutButtonLabel: { color: EMBER.primaryForeground, fontSize: 15, fontWeight: "600" },
});
