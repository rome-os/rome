import type { Meta, StoryObj } from "storybook-react-rsbuild";
import i18n from "../src/i18n";
import { ConnectionBrandBadge } from "../src/components/brand-icons/connection-badges";
import { ConnectionSlotCard, SoleSlotScope } from "../src/components/connection-slot-card";
import { ConnectionDetailHeader } from "../src/components/ConnectionDetail";
import { Button } from "../src/components/ui/button";
import { Dialog, DialogBody } from "../src/components/ui/dialog";
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
  component: ConnectionDetailHeader,
  parameters: { layout: "padded" },
  args: { onClose: () => undefined },
  argTypes: { card: { control: false }, onClose: { control: false } },
  render: (args) => {
    const slot = args.card.slots[0];
    const isConnected = slot.state !== "unauthorized";

    return (
      <Dialog open onClose={args.onClose} size="lg">
        <ConnectionDetailHeader {...args} />
        <DialogBody>
          <SoleSlotScope>
            <ConnectionSlotCard
              service={args.card.service}
              slot={slot}
              state={isConnected ? "connected" : "unconnected"}
              role="primary"
              icon={<ConnectionBrandBadge connection={args.card.service} />}
              identityTitle={isConnected ? slot.identity : null}
              action={
                isConnected ? (
                  <Button variant="destructive" size="sm" onClick={() => undefined}>
                    {i18n.t("common.disconnect", { ns: "settings" })}
                  </Button>
                ) : undefined
              }
            >
              {!isConnected && (
                <Button onClick={() => undefined}>
                  {i18n.t("common.connect", { ns: "settings" })}
                </Button>
              )}
            </ConnectionSlotCard>
          </SoleSlotScope>
        </DialogBody>
      </Dialog>
    );
  },
} satisfies Meta<typeof ConnectionDetailHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotConnected: Story = { args: { card: notConnected } };

export const Connected: Story = { args: { card: connected } };
