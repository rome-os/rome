import type { StorybookConfig } from "storybook-react-rsbuild";

const config: StorybookConfig = {
  framework: {
    name: "storybook-react-rsbuild",
    options: {
      builder: {
        rsbuildConfigPath: ".storybook/rsbuild.config.ts",
        lazyCompilation: false,
      },
    },
  },
  stories: ["./*.stories.tsx"],
  addons: [
    {
      name: "@storybook/addon-mcp",
      options: { toolsets: { test: false } },
    },
  ],
  features: { componentsManifest: true },
  core: { disableTelemetry: true },
};

export default config;
