import { PreviewScaleProvider } from "../src/hooks/use-preview-scale";
import { ThemeProvider } from "../src/hooks/use-theme";
import type { Meta, StoryObj } from "storybook-react-rsbuild";
import ComponentGalleryPage from "../src/pages/dev/gallery/ComponentGalleryPage";

const meta = {
  title: "Dev/Design/Gallery",
  component: ComponentGalleryPage,
  decorators: [
    (Story) => (
      <PreviewScaleProvider enabled>
        <ThemeProvider>
          <Story />
        </ThemeProvider>
      </PreviewScaleProvider>
    ),
  ],
} satisfies Meta<typeof ComponentGalleryPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
