import type { StorybookConfig } from "storybook-react-rsbuild";

const config: StorybookConfig = {
  framework: {
    name: "storybook-react-rsbuild",
    options: { builder: { rsbuildConfigPath: ".storybook/rsbuild.config.ts" } },
  },
  stories: ["./*.stories.tsx"],
  core: { disableTelemetry: true },
};

export default config;
