// `show_card`: the agent shows a display-only card in its message, such as a
// report's numbers as tiles.

import {
  parseShowCardInput,
  SHOW_CARD_COMPONENTS,
  showCardToolOutput,
} from "../domain/show-card.js";
import type { RomeTool } from "../domain/rome-tools.js";
import type { RomeToolRunner } from "./rome-tool-runner.js";

const EXAMPLE = JSON.stringify({
  components: [
    { id: "root", component: "Column", children: ["title", "tiles", "notes"] },
    { id: "title", component: "Text", variant: "h3", text: "Daily health summary" },
    { id: "tiles", component: "Row", justify: "spaceBetween", children: ["sleep", "steps", "hr"] },
    { id: "sleep", component: "Stat", label: "Sleep", value: "7h 25m" },
    { id: "steps", component: "Stat", label: "Steps", value: "5,673" },
    {
      id: "hr",
      component: "Stat",
      label: "Resting HR",
      value: 53,
      unit: "bpm",
      caption: "Usual 53–61",
    },
    { id: "notes", component: "List", children: ["n1"] },
    { id: "n1", component: "Text", text: "Sleep varied a lot this week." },
  ],
});

const DESCRIPTION =
  "Show a card in your message, for content the guardian scans rather than reads: a report or " +
  "summary with several numbers, such as a daily health summary, a budget or a status roundup. " +
  "Not for a conversational reply, a single fact, or anything you need answered. The card is " +
  "display only: it has no buttons, links or images, so put sources and links in your text " +
  "under it. A conclusion or summary you are asked to write still gives the key figures, since it may be read without the card. Where cards can't show, you are told to " +
  "send `text` as your message instead. Components, as A2UI: each has a unique `id`, and the one " +
  'with id "root" is drawn first. `Column`/`Row` (`children`: ids; Row `justify`: ' +
  '"spaceBetween" for tiles) and `List` (`children`) lay out; `Text` (`text`, `variant` h1–h5, ' +
  "caption or body); `Stat` is a metric tile (`label`, `value`, optional `unit` and `caption`, " +
  "such as the usual range); `Progress` (`value` from 0 to `max`, default 1, optional `label`). " +
  `Put at most three Stats in a Row, so they fit a phone. Example ui: ${EXAMPLE}`;

export function showCardTool(widgetsShow: boolean, run: RomeToolRunner): RomeTool {
  return {
    name: "show_card",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["ui", "text"],
      properties: {
        ui: {
          type: "object",
          required: ["components"],
          description: "The card: a flat list of components that name their children by id.",
          properties: {
            components: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["id", "component"],
                properties: {
                  id: { type: "string" },
                  component: { type: "string", enum: [...SHOW_CARD_COMPONENTS] },
                },
              },
            },
          },
        },
        text: {
          type: "string",
          description:
            "The card's content as plain text, for a reader that cannot draw it. Say everything the card says.",
        },
      },
    },
    handler: (input) =>
      run("show_card", input, async () => {
        const parsed = parseShowCardInput(input);
        if (!parsed.ok) throw new Error(parsed.error);
        return showCardToolOutput(parsed.ui, parsed.text, widgetsShow);
      }),
  };
}
