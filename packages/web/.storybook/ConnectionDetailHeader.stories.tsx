import type { Meta, StoryObj } from "storybook-react-rsbuild";
import { ConnectionDetailHeader } from "../src/components/ConnectionDetail";
import { Dialog } from "../src/components/ui/dialog";
import type { ConnectionCard } from "../src/lib/connection-cards";

const notConnected: ConnectionCard = {
  service: "discord",
  label: "Discord",
  kind: "channel",
  alwaysOn: false,
  degradation: null,
  slots: [
    {
      key: "bot",
      connectionId: null,
      grant: "bot",
      state: "unauthorized",
      display: null,
      identity: null,
      activeSetupCid: null,
    },
  ],
  connect: { url: "/api/connections/discord/start", available: true, unavailableReason: null },
};

const connected: ConnectionCard = {
  ...notConnected,
  slots: [{ ...notConnected.slots[0], connectionId: "storybook-discord", state: "authorized" }],
};

const meta = {
  title: "Dev/Connections/Channel status",
  component: ConnectionDetailHeader,
  parameters: { layout: "padded" },
  args: { onClose: () => undefined },
  argTypes: { card: { control: false }, onClose: { control: false } },
  render: (args) => (
    <Dialog open onClose={args.onClose} size="lg">
      <ConnectionDetailHeader {...args} />
    </Dialog>
  ),
} satisfies Meta<typeof ConnectionDetailHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotConnected: Story = { args: { card: notConnected } };

export const Connected: Story = { args: { card: connected } };
