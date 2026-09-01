import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

// How a design doc's Markdown renders. MDX hands every Markdown construct to
// the component named here, so prose picks up the same typography roles and
// semantic colors as the product it is describing — a doc and the UI it
// documents are read in one theme, not two.

function H1(props: ComponentPropsWithoutRef<"h1">) {
  return <h1 className="mt-10 mb-3 text-display text-foreground first:mt-0" {...props} />;
}

function H2(props: ComponentPropsWithoutRef<"h2">) {
  return (
    <h2
      className="mt-10 mb-3 border-b border-border-subtle pb-2 text-title text-foreground"
      {...props}
    />
  );
}

function H3(props: ComponentPropsWithoutRef<"h3">) {
  return <h3 className="mt-6 mb-2 text-section text-foreground" {...props} />;
}

function P(props: ComponentPropsWithoutRef<"p">) {
  return <p className="my-3 text-body text-muted-foreground" {...props} />;
}

function Ul(props: ComponentPropsWithoutRef<"ul">) {
  return <ul className="my-3 list-disc pl-6 text-body text-muted-foreground" {...props} />;
}

function Ol(props: ComponentPropsWithoutRef<"ol">) {
  return <ol className="my-3 list-decimal pl-6 text-body text-muted-foreground" {...props} />;
}

function Li(props: ComponentPropsWithoutRef<"li">) {
  return <li className="my-1" {...props} />;
}

function Strong(props: ComponentPropsWithoutRef<"strong">) {
  return <strong className="font-medium text-foreground" {...props} />;
}

function A(props: ComponentPropsWithoutRef<"a">) {
  return (
    <a
      className="text-primary underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  );
}

function Code({ className, ...props }: ComponentPropsWithoutRef<"code">) {
  return (
    <code
      className={cn(
        "rounded-4 bg-surface-muted px-2 py-1 font-mono text-aux text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function Pre(props: ComponentPropsWithoutRef<"pre">) {
  return (
    <pre
      className="my-4 overflow-x-auto rounded-12 border border-border bg-surface p-4 font-mono text-aux text-foreground [&_code]:bg-transparent [&_code]:p-0"
      {...props}
    />
  );
}

function Blockquote(props: ComponentPropsWithoutRef<"blockquote">) {
  return (
    <blockquote
      className="my-4 border-l-2 border-border-strong pl-4 text-body text-muted-foreground italic"
      {...props}
    />
  );
}

function Hr() {
  return <hr className="my-8 border-border-subtle" />;
}

function Table(props: ComponentPropsWithoutRef<"table">) {
  return (
    <div className="my-4 overflow-x-auto rounded-12 border border-border">
      <table className="w-full text-ui" {...props} />
    </div>
  );
}

function Th(props: ComponentPropsWithoutRef<"th">) {
  return (
    <th
      className="border-b border-border-subtle bg-surface px-3 py-2 text-left text-badge text-foreground"
      {...props}
    />
  );
}

function Td(props: ComponentPropsWithoutRef<"td">) {
  return (
    <td className="border-b border-border-subtle px-3 py-2 text-muted-foreground" {...props} />
  );
}

/**
 * A rendered specimen: the live component, with the design claim it is there
 * to show underneath it. Available to every doc without an import.
 */
export function Specimen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <figure className="my-6">
      {title && (
        <figcaption className="mb-2 text-badge text-subtle-foreground uppercase">
          {title}
        </figcaption>
      )}
      {children}
    </figure>
  );
}

/** A design invariant called out of the prose — the rule a reviewer checks. */
export function Invariant({ children }: { children: ReactNode }) {
  return (
    <aside className="my-4 rounded-12 border border-border-strong bg-surface p-4">
      <div className="mb-1 text-badge text-subtle-foreground uppercase">Invariant</div>
      <div className="text-body text-foreground">{children}</div>
    </aside>
  );
}

export const mdxComponents = {
  h1: H1,
  h2: H2,
  h3: H3,
  p: P,
  ul: Ul,
  ol: Ol,
  li: Li,
  strong: Strong,
  a: A,
  code: Code,
  pre: Pre,
  blockquote: Blockquote,
  hr: Hr,
  table: Table,
  th: Th,
  td: Td,
  Specimen,
  Invariant,
} as const;
