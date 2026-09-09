import { MemoryRouter } from "react-router-dom";
import type { Meta, StoryObj } from "storybook-react-rsbuild";
import "../src/i18n";
import MdxDocsPage from "../src/pages/dev/mdx/MdxDocsPage";

const meta = {
  title: "Dev/Design/MDX",
  component: MdxDocsPage,
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={["/?doc=people-page"]}>
        <Story />
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof MdxDocsPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
