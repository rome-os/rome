import type { Preview } from "storybook-react-rsbuild";
import { useLayoutEffect, type ReactNode } from "react";
import { ThemeProvider, useTheme } from "../src/hooks/use-theme";
import { injectThemeCss, readStoredPreference, type ThemePreference } from "../src/lib/theme";
import "../src/globals.css";

injectThemeCss();

function ColorMode({ mode, children }: { mode: ThemePreference; children: ReactNode }) {
  const { preference, setPreference } = useTheme();
  useLayoutEffect(() => {
    if (preference !== mode) setPreference(mode);
  }, [mode, preference, setPreference]);
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
  initialGlobals: { colorMode: readStoredPreference() },
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
