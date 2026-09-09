import type { Meta, StoryObj } from "storybook-react-rsbuild";
import ChatBlocksPage from "../src/pages/dev/ChatBlocksPage";

const meta = {
  title: "Dev/Previews/Chat blocks",
  component: ChatBlocksPage,
} satisfies Meta<typeof ChatBlocksPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
