import { createRoot } from "react-dom/client";
import { Compass } from "lucide-react";
import { defineComponent, navigateRome, type AppComponentContext } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { getWelcomeCopy } from "@/lib/copy";

// The "pick your first app" card. props: `{ ideas: [{title, prompt}] }`. Each
// idea renders as a shadcn Item (title + description, with a "Build this" action
// on the right). Either button resolves this turn, which ends the welcome, and
// then hands the guardian to a FRESH chat (not this welcome session): "Build
// this" opens it with the idea's kickoff prompt in the composer, ready to send,
// and "I'll explore on my own" submits the `EXPLORE` sentinel and opens it
// empty.
export const EXPLORE = "__explore__";

interface Idea {
  title: string;
  prompt: string;
}

function readIdeas(value: unknown): Idea[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((i) =>
    i &&
    typeof i === "object" &&
    typeof (i as Idea).title === "string" &&
    typeof (i as Idea).prompt === "string"
      ? [{ title: (i as Idea).title, prompt: (i as Idea).prompt }]
      : [],
  );
}

function IdeaPicker({ ctx }: { ctx: AppComponentContext }) {
  const copy = getWelcomeCopy(ctx.bootstrap.shell.locale);
  const ideas = readIdeas(ctx.props.ideas);
  const resolved = ctx.host.resolved;

  // The submit posts the resolution first, so the welcome session records the
  // choice before the shell swaps the route to the new chat.
  const build = (idea: Idea) => {
    ctx.host.submit({ ideaTitle: idea.title }, idea.title);
    navigateRome({ path: "chat/new", draft: idea.prompt });
  };

  const explore = () => {
    ctx.host.submit({ ideaTitle: EXPLORE }, copy.ideas.exploreSummary);
    navigateRome({ path: "chat/new" });
  };

  return (
    <div className="w-full max-w-md space-y-2">
      <p className="text-sm font-medium text-foreground">{copy.ideas.heading}</p>

      {ideas.map((idea) => (
        <Item key={idea.title}>
          <ItemContent>
            <ItemTitle>{idea.title}</ItemTitle>
            <ItemDescription>{idea.prompt}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" disabled={resolved} onClick={() => build(idea)}>
              {copy.ideas.build}
            </Button>
          </ItemActions>
        </Item>
      ))}

      <Button
        variant="ghost"
        size="sm"
        disabled={resolved}
        className="text-muted-foreground"
        onClick={explore}
      >
        <Compass /> {copy.ideas.explore}
      </Button>
    </div>
  );
}

defineComponent("idea-picker", (container, ctx) => {
  const root = createRoot(container);
  root.render(<IdeaPicker ctx={ctx} />);
  return () => root.unmount();
});
