import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import type { Meta, StoryObj } from "storybook-react-rsbuild";
import "../src/i18n";
import MdxDocsPage from "../src/pages/dev/mdx/MdxDocsPage";

function StorybookDevIndex() {
  return (
    <main className="min-h-screen bg-background px-6 py-8 text-foreground">
      <h1 className="text-title">Dev pages</h1>
      <p className="mt-2 text-body text-muted-foreground">
        Use Storybook’s Dev/Design group to open another design page.
      </p>
      <Link
        to="/dev/mdx?doc=people-page"
        className="mt-6 inline-block text-ui text-foreground hover:underline"
      >
        Design docs
      </Link>
    </main>
  );
}

const meta = {
  title: "Dev/Design/MDX",
  component: MdxDocsPage,
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={["/dev/mdx?doc=people-page"]}>
        <Routes>
          <Route path="/dev" element={<StorybookDevIndex />} />
          <Route path="/dev/mdx" element={<Story />} />
        </Routes>
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof MdxDocsPage>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
