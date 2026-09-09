import type { Meta, StoryObj } from "storybook-react-rsbuild";
import ConnectionGalleryPage from "../src/pages/dev/ConnectionGalleryPage";

const meta = {
  title: "Dev/Previews/Connections",
  component: ConnectionGalleryPage,
} satisfies Meta<typeof ConnectionGalleryPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
