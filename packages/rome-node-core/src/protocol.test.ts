import { describe, expect, it } from "@rstest/core";
import { gatewayMessage, gatewayNotification, NOTIFICATION_LIMITS } from "./protocol.js";

const valid = { type: "notification", title: "Rome", body: "Hello", instanceId: "inst-1" };

describe("gatewayNotification", () => {
  it("accepts the required fields", () => {
    expect(gatewayNotification(valid)).toEqual({
      title: "Rome",
      body: "Hello",
      instanceId: "inst-1",
    });
  });
  it("keeps level and chatId and drops unknown fields", () => {
    expect(
      gatewayNotification({ ...valid, level: "passive", chatId: "chat_1", extra: "x" }),
    ).toEqual({
      title: "Rome",
      body: "Hello",
      instanceId: "inst-1",
      level: "passive",
      chatId: "chat_1",
    });
    expect(gatewayNotification({ ...valid, level: "active" })?.level).toBe("active");
  });
  it.each([
    null,
    "notification",
    [],
    {},
    { ...valid, type: "other" },
    { ...valid, title: undefined },
    { ...valid, title: "" },
    { ...valid, body: 1 },
    { ...valid, body: "" },
    { ...valid, instanceId: undefined },
    { ...valid, level: "loud" },
    { ...valid, level: null },
    { ...valid, chatId: 7 },
    { ...valid, chatId: "" },
  ])("rejects %j", (value) => {
    expect(gatewayNotification(value)).toBeNull();
  });
  it("bounds string lengths", () => {
    const { title, body, id } = NOTIFICATION_LIMITS;
    expect(gatewayNotification({ ...valid, body: "a".repeat(body) })).not.toBeNull();
    expect(gatewayNotification({ ...valid, body: "a".repeat(body + 1) })).toBeNull();
    expect(gatewayNotification({ ...valid, title: "a".repeat(title + 1) })).toBeNull();
    expect(gatewayNotification({ ...valid, instanceId: "a".repeat(id + 1) })).toBeNull();
    expect(gatewayNotification({ ...valid, chatId: "a".repeat(id + 1) })).toBeNull();
  });
  it("is never a relayed peer message", () => {
    expect(gatewayNotification({ ...valid, id: "1", from: "peer", payload: {} })).toBeNull();
    expect(gatewayNotification({ ...valid, id: "1" })).toBeNull();
    expect(gatewayNotification({ ...valid, from: "peer" })).toBeNull();
  });
  it("leaves gatewayMessage ignoring it", () => {
    expect(gatewayMessage(valid)).toBeNull();
  });
});
