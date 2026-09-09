import type { Meta, StoryObj } from "storybook-react-rsbuild";
import LoginPreviewPage from "../src/pages/dev/LoginPreviewPage";

const meta = {
  title: "Dev/Previews/Login",
  component: LoginPreviewPage,
} satisfies Meta<typeof LoginPreviewPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
