import type { Meta, StoryObj } from "storybook-react-rsbuild";
import OnboardPreviewPage from "../src/pages/dev/OnboardPreviewPage";

const meta = {
  title: "Dev/Previews/Onboarding",
  component: OnboardPreviewPage,
} satisfies Meta<typeof OnboardPreviewPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
