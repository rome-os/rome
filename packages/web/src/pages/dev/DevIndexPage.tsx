import { Link } from "react-router-dom";
import { DEV_ROUTES } from "./dev-routes";

// Dev-only index at /dev. Renders one link per entry in the DEV_ROUTES
// registry, so it stays in sync automatically: adding a dev page = adding a
// registry entry, no edit here. Gated behind `import.meta.env.DEV` in App.tsx.

export default function DevIndexPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-title text-foreground">Dev pages</h1>
        <p className="text-ui text-muted-foreground">
          Dev-only surfaces. This index and every page it links are dropped from production builds.
        </p>
      </header>

      <ul className="divide-y divide-border">
        {DEV_ROUTES.map((route) => (
          <li key={route.path}>
            <Link
              to={route.path}
              className="block px-6 py-4 transition-colors hover:bg-surface-hover"
            >
              <div className="flex items-baseline gap-3">
                <span className="text-ui text-foreground">{route.title}</span>
                <code className="text-aux text-muted-foreground">{route.path}</code>
              </div>
              <p className="mt-1 text-ui text-muted-foreground">{route.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
