import type { Meta, StoryObj } from "storybook-react-rsbuild";
import { MemoryRouter } from "react-router-dom";
import "../src/i18n";
import { ConnectionDetailDialog } from "../src/components/ConnectionDetail";
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
  slots: [
    {
      ...notConnected.slots[0],
      connectionId: "storybook-discord",
      state: "authorized",
      identity: "Rome Bot",
    },
  ],
};

const meta = {
  title: "Dev/Connections/Channel status",
  component: ConnectionDetailDialog,
  parameters: { layout: "padded" },
  args: {
    composio: null,
    onClose: () => undefined,
    onRefresh: () => undefined,
    onFlash: () => undefined,
  },
  argTypes: {
    card: { control: false },
    composio: { control: false },
    onClose: { control: false },
    onRefresh: { control: false },
    onFlash: { control: false },
  },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof ConnectionDetailDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotConnected: Story = { args: { card: notConnected } };

export const Connected: Story = { args: { card: connected } };
