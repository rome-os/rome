import type { Meta, StoryObj } from "storybook-react-rsbuild";
import "../src/i18n";
import { ConnectionBrandBadge } from "../src/components/brand-icons/connection-badges";
import { ConnectionSlotCard } from "../src/components/connection-slot-card";
import type { ConnectionSlot } from "../src/lib/connection-cards";

const availableSlot: ConnectionSlot = {
  key: "user",
  connectionId: null,
  grant: "user",
  state: "unauthorized",
  display: null,
  identity: null,
  activeSetupCid: null,
};

const connectedSlot: ConnectionSlot = {
  ...availableSlot,
  connectionId: "storybook-github",
  state: "authorized",
  display: { displayName: "Zhang Fan", handle: "zhangfand", email: null, avatarUrl: null },
  identity: "Zhang Fan",
};

const meta = {
  title: "Dev/Connections/Slot card",
  component: ConnectionSlotCard,
  parameters: { layout: "padded" },
  argTypes: { icon: { control: false } },
  render: (args) => (
    <div className="max-w-xl">
      <ConnectionSlotCard {...args} icon={<ConnectionBrandBadge connection="github" />} />
    </div>
  ),
} satisfies Meta<typeof ConnectionSlotCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotConnected: Story = {
  args: {
    service: "github",
    slot: availableSlot,
    state: "unconnected",
    role: "primary",
    icon: null,
  },
};

export const Connected: Story = {
  args: {
    service: "github",
    slot: connectedSlot,
    state: "connected",
    role: "primary",
    identityTitle: connectedSlot.identity,
    connectedSubtitle: connectedSlot.display?.handle,
    icon: null,
  },
};
