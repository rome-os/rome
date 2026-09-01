import { describe, expect, it } from "@rstest/core";
import {
  resolveRomeNewsDefinition,
  RomeNewsFeedSchema,
  type RomeNewsDefinition,
} from "@rome-os/rome-web-components/news-item/schema";

import { getQuickEntries } from "@/config/quick-entries";

const cloudDefinition: RomeNewsDefinition = {
  id: "cloud-news",
  type: "chat",
  title: { en: "Cloud announcement", "zh-CN": "云端公告" },
  subtitle: {
    en: "One payload for every locale",
    "zh-CN": "一份数据包含所有语言",
  },
  image: "https://assets.example.com/news.png",
  prompt: { en: "Tell me more", "zh-CN": "告诉我更多" },
  mode: "draft",
};

describe("quick entries", () => {
  it("resolves actions supplied by Rome Cloud", () => {
    const entry = getQuickEntries(
      [
        {
          id: "cloud-link",
          type: "link",
          target: "internal",
          title: { en: "Cloud link", "zh-CN": "云端链接" },
          image: "https://assets.example.com/link.png",
          href: "/apps/example",
        },
      ],
      "en",
    ).find((item) => item.id === "cloud-link");

    expect(entry).toMatchObject({
      type: "link",
      href: "/apps/example",
      target: "internal",
    });
  });

  it("resolves Chinese locally and falls back to English for unknown locales", () => {
    expect(resolveRomeNewsDefinition(cloudDefinition, "zh-CN")).toMatchObject({
      title: "云端公告",
      subtitle: "一份数据包含所有语言",
      prompt: "告诉我更多",
    });
    expect(resolveRomeNewsDefinition(cloudDefinition, "fr")).toMatchObject({
      title: "Cloud announcement",
      subtitle: "One payload for every locale",
      prompt: "Tell me more",
    });
  });

  it("preserves meaningful whitespace in chat prompts", () => {
    const parsed = RomeNewsFeedSchema.parse({
      version: 1,
      items: [
        {
          ...cloudDefinition,
          prompt: {
            en: "Tell me more ",
            "zh-CN": "告诉我更多 ",
          },
        },
      ],
    });

    expect(parsed.items[0]).toMatchObject({
      prompt: {
        en: "Tell me more ",
        "zh-CN": "告诉我更多 ",
      },
    });
    expect(
      RomeNewsFeedSchema.safeParse({
        version: 1,
        items: [
          {
            ...cloudDefinition,
            prompt: {
              en: "   ",
              "zh-CN": "告诉我更多",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires the complete locale payload and caps the feed at 10 items", () => {
    expect(
      RomeNewsFeedSchema.safeParse({
        version: 1,
        items: Array.from({ length: 11 }, (_, index) => ({
          ...cloudDefinition,
          id: `cloud-news-${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      RomeNewsFeedSchema.safeParse({
        version: 1,
        items: [
          {
            ...cloudDefinition,
            title: { en: "Missing Chinese title" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RomeNewsFeedSchema.safeParse({
        version: 1,
        items: [cloudDefinition, cloudDefinition],
      }).success,
    ).toBe(false);
  });
});
