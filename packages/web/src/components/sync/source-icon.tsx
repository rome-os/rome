import type { SVGProps } from "react";
import { Cloud } from "lucide-react";
import { GithubIcon } from "@/components/brand-icons/github-icon";
import { GoogleIcon } from "@/components/brand-icons/google-icon";

/** Maps a source id / icon hint to its brand logo. Source-agnostic: a new
 * source registers its glyph here and everything else stays the same. */
export function SourceIcon({ source, ...props }: { source?: string } & SVGProps<SVGSVGElement>) {
  if (source === "git" || source === "github") {
    return <GithubIcon {...props} />;
  }
  if (source === "googledrive" || source === "google") {
    return <GoogleIcon {...props} />;
  }
  return <Cloud {...props} aria-hidden />;
}
