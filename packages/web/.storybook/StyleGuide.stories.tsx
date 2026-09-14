import type { Meta, StoryObj } from "storybook-react-rsbuild";
import StyleGuidePage from "../src/pages/dev/StyleGuidePage";

const meta = {
  title: "Dev/Design/Styleguide",
  component: StyleGuidePage,
  args: { compareModes: false },
} satisfies Meta<typeof StyleGuidePage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
