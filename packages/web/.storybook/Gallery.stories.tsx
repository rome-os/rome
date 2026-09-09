import type { Meta, StoryObj } from "storybook-react-rsbuild";
import ComponentGalleryPage from "../src/pages/dev/gallery/ComponentGalleryPage";

const meta = {
  title: "Dev/Design/Gallery",
  component: ComponentGalleryPage,
} satisfies Meta<typeof ComponentGalleryPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
