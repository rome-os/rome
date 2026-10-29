import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderReact, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";

export function render(ui: ReactNode, options?: RenderOptions) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Wrapper = options?.wrapper;
  return renderReact(ui, {
    ...options,
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </QueryClientProvider>
    ),
  });
}
