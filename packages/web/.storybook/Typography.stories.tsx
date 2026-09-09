import type { Meta, StoryObj } from "storybook-react-rsbuild";
import TypographyPage from "../src/pages/dev/TypographyPage";

const meta = {
  title: "Dev/Design/Typography",
  component: TypographyPage,
} satisfies Meta<typeof TypographyPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
