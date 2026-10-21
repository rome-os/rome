import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" align="start" className="self-start">
      <Link to={to}>
        <ArrowLeft data-icon="inline-start" />
        {children}
      </Link>
    </Button>
  );
}
