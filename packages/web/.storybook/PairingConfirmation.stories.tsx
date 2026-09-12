import type { Meta, StoryObj } from "storybook-react-rsbuild";
import { PairingConfirmationDialog } from "../src/components/pairing/pairing-views";
import { pairingStory, ignorePairingAction } from "./pairing-fixtures";

const meta = {
  title: "Connections/Pairing/Confirmation",
  component: PairingConfirmationDialog,
  parameters: { layout: "padded" },
  args: {
    ...pairingStory().confirmation,
    open: true,
    onCancel: ignorePairingAction,
    onConfirm: ignorePairingAction,
  },
} satisfies Meta<typeof PairingConfirmationDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Confirm: Story = {};
export const Submitting: Story = { args: { busy: true } };
export const Failed: Story = { args: { error: true } };
