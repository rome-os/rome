import { defineAction, z, type Action, type ActionConfig } from "@rome-os/app-runtime";

const button = (id: string, label: string, event: string, variant?: string) => [
  {
    id,
    component: "Button",
    child: `${id}-label`,
    ...(variant ? { variant } : {}),
    action: { event: { name: `connect-card/${event}`, context: {} } },
  },
  { id: `${id}-label`, component: "Text", text: label },
];

/** Shows Fake Service's connect card, described as data, and waits on it. */
export function createAction(config: ActionConfig): Action {
  return defineAction({
    config,
    schema: z.object({}),
    execute: async () => ({
      status: "show_widget",
      widget: {
        text: "To connect Fake Service, press Connect on the card, sign in, then press I've authorized.",
        waits: true,
        ui: {
          components: [
            { id: "root", component: "Column", children: ["title", "note", "actions"] },
            { id: "title", component: "Text", text: "Connect Fake Service", variant: "h4" },
            {
              id: "note",
              component: "Text",
              text: "Press Connect and sign in to Fake Service in the page that opens, then come back and press I've authorized.",
              variant: "caption",
            },
            { id: "actions", component: "Row", children: ["dismiss", "check", "connect"], justify: "end" },
            ...button("dismiss", "Dismiss", "dismiss", "borderless"),
            ...button("check", "I've authorized", "check"),
            ...button("connect", "Connect", "connect", "primary"),
          ],
        },
      },
    }),
  });
}
