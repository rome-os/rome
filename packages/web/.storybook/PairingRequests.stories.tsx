import type { Meta, StoryObj } from "storybook-react-rsbuild";
import {
  PairingRequestsSection,
  PairingRequestCard,
  PairingCodeSection,
} from "../src/components/pairing/pairing-views";
import { pairingStory, ignorePairingAction } from "./pairing-fixtures";

const meta = {
  title: "Connections/Pairing/Requests",
  component: PairingRequestsSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-lg">
        <Story />
      </div>
    ),
  ],
  args: {
    state: "empty",
    onRetry: ignorePairingAction,
    activityLink: (
      <a href="#pairing-history" className="text-primary underline underline-offset-4" />
    ),
  },
} satisfies Meta<typeof PairingRequestsSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Loading: Story = { args: { state: "loading" } };
export const Failed: Story = { args: { state: "error" } };
export const MultipleRequests: Story = {
  args: {
    state: "ready",
    children: [0, 1, 2].map((index) => (
      <PairingRequestCard
        key={index}
        {...pairingStory(index).card}
        onApprove={ignorePairingAction}
        onReject={ignorePairingAction}
      >
        <PairingCodeSection
          {...pairingStory(index).code}
          state={{ kind: "ready", code: `RP-12AB34C${index}`, copied: false }}
          onCopy={ignorePairingAction}
          onRetry={ignorePairingAction}
        />
      </PairingRequestCard>
    )),
  },
};
