import type { Meta, StoryObj } from "storybook-react-rsbuild";
import "../src/i18n";
import { ConnectionBrandBadge } from "../src/components/brand-icons/connection-badges";
import { Button } from "../src/components/ui/button";
import { AvailableToAddLabel, ConnectionSlotCard } from "../src/components/connection-slot-card";
import type { ConnectionSlot } from "../src/lib/connection-cards";

const telegramBot: ConnectionSlot = {
  key: "bot",
  connectionId: null,
  grant: "bot",
  state: "unauthorized",
  display: null,
  identity: null,
  activeSetupCid: null,
};

const telegramSession: ConnectionSlot = {
  key: "session",
  connectionId: null,
  grant: "session",
  state: "unauthorized",
  display: null,
  identity: null,
  activeSetupCid: null,
};

const meta = {
  title: "Dev/Connections/Slot card",
  component: ConnectionSlotCard,
  parameters: { layout: "padded" },
  argTypes: {
    service: { control: false },
    slot: { control: false },
    state: { control: false },
    role: { control: false },
    icon: { control: false },
    identityTitle: { control: false },
    connectedSubtitle: { control: false },
    action: { control: false },
    children: { control: false },
  },
} satisfies Meta<typeof ConnectionSlotCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UnconnectedBot: Story = {
  args: {
    service: "telegram",
    slot: telegramBot,
    state: "unconnected",
    role: "primary",
    icon: <ConnectionBrandBadge connection="telegram" />,
    children: <Button>Connect</Button>,
  },
};

export const ConnectedBot: Story = {
  args: {
    service: "telegram",
    slot: {
      ...telegramBot,
      connectionId: "storybook-telegram",
      state: "authorized",
      identity: "@rome_bot",
    },
    state: "connected",
    role: "primary",
    icon: <ConnectionBrandBadge connection="telegram" />,
    identityTitle: "@rome_bot",
    action: (
      <Button variant="destructive" size="sm">
        Disconnect
      </Button>
    ),
  },
};

export const AddSession: Story = {
  render: (args) => (
    <div className="space-y-2">
      <AvailableToAddLabel />
      <ConnectionSlotCard {...args} />
    </div>
  ),
  args: {
    service: "telegram",
    slot: telegramSession,
    state: "unconnected",
    role: "secondary",
    icon: <ConnectionBrandBadge connection="telegram" />,
    children: (
      <Button variant="outline" size="sm">
        Add session
      </Button>
    ),
  },
};
