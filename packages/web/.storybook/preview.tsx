import type { Preview } from "storybook-react-rsbuild";
import { useEffect, type ReactNode } from "react";
import { ThemeProvider, useTheme } from "../src/hooks/use-theme";
import { injectThemeCss, type ThemePreference } from "../src/lib/theme";
import "../src/globals.css";

injectThemeCss();

function ColorMode({ mode, children }: { mode: ThemePreference; children: ReactNode }) {
  const { setPreference } = useTheme();
  useEffect(() => setPreference(mode), [mode, setPreference]);
  return children;
}

const preview: Preview = {
  parameters: { layout: "fullscreen" },
  globalTypes: {
    colorMode: {
      description: "Preview color mode",
      toolbar: {
        title: "Color mode",
        icon: "circlehollow",
        dynamicTitle: true,
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
          { value: "system", title: "System", icon: "browser" },
        ],
      },
    },
  },
  initialGlobals: { colorMode: "system" },
  decorators: [
    (Story, { globals }) => (
      <ThemeProvider>
        <ColorMode
          mode={
            globals.colorMode === "light" || globals.colorMode === "dark"
              ? globals.colorMode
              : "system"
          }
        >
          <Story />
        </ColorMode>
      </ThemeProvider>
    ),
  ],
};

export default preview;
