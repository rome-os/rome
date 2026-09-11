import { useState } from "react";
import type { Meta, StoryObj } from "storybook-react-rsbuild";
import {
  PairingRequestCard,
  PairingCodeSection,
  PairingConfirmationDialog,
  type PairingRequestCardProps,
} from "../src/components/pairing/pairing-views";
import { pairingStory, ignorePairingAction } from "./pairing-fixtures";

const specimen = pairingStory();
const meta = {
  title: "Connections/Pairing/Request",
  component: PairingRequestCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-lg">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    channel: {
      control: "select",
      options: [0, 1, 2].map((index) => pairingStory(index).card.channel),
    },
  },
  args: { ...specimen.card, onApprove: ignorePairingAction, onReject: ignorePairingAction },
} satisfies Meta<typeof PairingRequestCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const LongIdentity: Story = {
  args: {
    name: "Alexandra — Personal account with a long display name",
    accountId: "ou_0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz",
  },
};
export const Approving: Story = { args: { busy: "approve" } };
export const Rejecting: Story = { args: { busy: "reject" } };
export const Failed: Story = { args: { error: true } };
export const Approved: Story = {
  args: { status: "approved", resolvedBy: "guardian", resolvedAt: "2026-09-10T10:04:00.000Z" },
};
export const Rejected: Story = {
  args: { status: "rejected", resolvedBy: "guardian", resolvedAt: "2026-09-10T10:04:00.000Z" },
};
export const Expired: Story = { args: { status: "expired" } };

function PairingInteraction({
  initiallyConfirming = false,
  ...args
}: PairingRequestCardProps & { initiallyConfirming?: boolean }) {
  const [confirming, setConfirming] = useState(initiallyConfirming);
  const [copied, setCopied] = useState(false);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  return (
    <>
      <PairingRequestCard
        {...args}
        status={decision ?? args.status}
        resolvedBy={decision ? "guardian" : args.resolvedBy}
        resolvedAt={decision ? "2026-09-10T10:04:00.000Z" : args.resolvedAt}
        onApprove={() => setConfirming(true)}
        onReject={() => setDecision("rejected")}
      >
        <PairingCodeSection
          channel={args.channel}
          accountName={args.name}
          state={{ kind: "ready", code: "RP-12AB34CD", copied }}
          onCopy={() => setCopied(true)}
          onRetry={ignorePairingAction}
        />
      </PairingRequestCard>
      <PairingConfirmationDialog
        name={args.name}
        accountId={args.accountId}
        channel={args.channel}
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setDecision("approved");
          setConfirming(false);
        }}
      />
    </>
  );
}
export const Interactive: Story = {
  render: (args) => <PairingInteraction {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          "Local preview: approval, rejection, and copy callbacks update only this story. No account is authorized and no clipboard is written.",
      },
    },
  },
};
export const ApprovalInteraction: Story = {
  name: "Approval confirmation",
  render: (args) => <PairingInteraction {...args} initiallyConfirming />,
};
