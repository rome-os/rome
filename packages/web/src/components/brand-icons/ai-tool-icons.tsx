import { useId, type SVGProps } from "react";
import { Cpu, Link2Off } from "lucide-react";

import { cn } from "@/lib/utils";
import { RomeLogo } from "@/components/logo";

export type AiToolBrandIconName = "chatgpt" | "claude" | "gemini" | "grok" | "pi";

/**
 * Paired Rome + Codex brand lockup: the two badges with a link-slash between
 * them, signalling the connection being made or broken. Use it as the header
 * mark of a Codex connect/disconnect dialog so it's clear which integration is
 * affected.
 */
export function RomeCodexLockup({ className }: { className?: string }) {
  return (
    <div className={cn("flex w-fit items-center gap-2", className)} aria-hidden>
      {/* The Rome mark's inner cut-outs render against `--background`; on the
          ember badge, pin `--background` to the badge color so the helmet stays
          a clean silhouette instead of showing a mismatched inset. */}
      <div className="flex h-9 w-9 items-center justify-center rounded-8 bg-primary text-primary-foreground [--background:var(--primary)]">
        <RomeLogo className="h-5 w-5" />
      </div>
      <Link2Off className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex h-9 w-9 items-center justify-center rounded-8 border border-border-strong bg-white text-[#111111]">
        <CodexIcon className="h-5 w-5" />
      </div>
    </div>
  );
}

/** The monochrome marks (ChatGPT, Grok) share one plate: the owner's black on white. */
const MONO_BADGE_CLASSES = "border-border-strong bg-white text-[#111111]";

const BADGE_CLASSES: Record<AiToolBrandIconName, string> = {
  chatgpt: MONO_BADGE_CLASSES,
  claude: "border-[#ead8c7] bg-[#fbf4eb] text-[#d97757]",
  gemini: "border-border-strong bg-white text-[#4285f4]",
  grok: MONO_BADGE_CLASSES,
  pi: MONO_BADGE_CLASSES,
};

export function AiToolIconBadge({
  icon,
  className,
}: {
  icon: AiToolBrandIconName;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-8 border",
        BADGE_CLASSES[icon],
        className,
      )}
      aria-hidden
    >
      <AiToolBrandIcon icon={icon} className="h-6 w-6" />
    </div>
  );
}

export function AiToolBrandIcon({
  icon,
  ...props
}: SVGProps<SVGSVGElement> & { icon: AiToolBrandIconName }) {
  if (icon === "chatgpt") return <ChatGPTIcon {...props} />;
  if (icon === "claude") return <ClaudeCodeIcon {...props} />;
  if (icon === "grok") return <GrokIcon {...props} />;
  if (icon === "pi") return <Cpu {...props} />;
  return <GeminiIcon {...props} />;
}

export function ChatGPTIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  const path =
    "M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z";

  return (
    <svg
      viewBox="0 0 2406 2406"
      fill="currentColor"
      role="img"
      aria-label="ChatGPT"
      className={className}
      {...props}
    >
      <path d={path} />
      <path d={path} transform="rotate(60 1203 1203)" />
      <path d={path} transform="rotate(120 1203 1203)" />
      <path d={path} transform="rotate(180 1203 1203)" />
      <path d={path} transform="rotate(240 1203 1203)" />
      <path d={path} transform="rotate(300 1203 1203)" />
    </svg>
  );
}

export function ClaudeCodeIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={className}
      overflow="visible"
      viewBox="0 0 100 101"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Claude"
      {...props}
    >
      <path
        d="M96.0000 40.0000 L99.5002 42.0000 L99.5002 43.5000 L98.5000 47.0000 L56.0000 57.0000 L52.0040 47.0708 L96.0000 40.0000 M96.0000 40.0000 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(330deg) scaleY(1.15445) rotate(-330deg)",
        }}
      />
      <path
        d="M80.1032 10.5903 L84.9968 11.6171 L86.2958 13.2179 L87.5346 17.0540 L87.0213 19.5007 L58.5000 58.5000 L49.0000 49.0000 L75.3008 14.4873 L80.1032 10.5903 M80.1032 10.5903 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(300deg) scaleY(1.14778) rotate(-300deg)",
        }}
      />
      <path
        d="M55.5002 4.5000 L58.5005 2.5000 L61.0002 3.5000 L63.5002 7.0000 L56.6511 48.1620 L52.0005 45.0000 L50.0005 39.5000 L53.5003 8.5000 L55.5002 4.5000 M55.5002 4.5000 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(270deg) scaleY(0.946115) rotate(-270deg)",
        }}
      />
      <path
        d="M23.4253 5.1588 L26.5075 1.2217 L28.5175 0.7632 L32.5063 1.3458 L34.4748 2.8868 L48.8202 34.6902 L54.0089 49.8008 L47.9378 53.1760 L24.8009 11.1886 L23.4253 5.1588 M23.4253 5.1588 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(240deg) scaleY(1.09) rotate(-240deg)",
        }}
      />
      <path
        d="M8.4990 27.0019 L7.4999 23.0001 L10.5003 19.5001 L14.0003 20.0001 L15.0003 20.0001 L36.0000 35.5000 L42.5000 40.5000 L51.5000 47.5000 L46.5000 56.0000 L42.0002 52.5000 L39.0001 49.5000 L10.0000 29.0001 L8.4990 27.0019 M8.4990 27.0019 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(210deg) scaleY(0.955) rotate(-210deg)",
        }}
      />
      <path
        d="M2.5003 53.0000 L0.2370 50.5000 L0.2373 48.2759 L2.5003 47.5000 L28.0000 49.0000 L53.0000 51.0000 L52.1885 55.9782 L4.5000 53.5000 L2.5003 53.0000 M2.5003 53.0000 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(180deg) scaleY(1.045) rotate(-180deg)",
        }}
      />
      <path
        d="M17.5002 79.0264 L12.5005 79.0264 L10.5124 76.7369 L10.5124 74.0000 L19.0005 68.0000 L53.5082 46.0337 L57.0005 52.0000 L17.5002 79.0264 M17.5002 79.0264 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(150deg) scaleY(0.925) rotate(-150deg)",
        }}
      />
      <path
        d="M27.0004 92.9999 L25.0003 93.4999 L22.0003 91.9999 L22.5004 89.4999 L52.0003 50.5000 L56.0004 55.9999 L34.0003 85.0000 L27.0004 92.9999 M27.0004 92.9999 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(120deg) scaleY(0.985) rotate(-120deg)",
        }}
      />
      <path
        d="M51.9998 98.0000 L50.5002 100.0000 L47.5002 101.0000 L45.0001 99.0000 L43.5000 96.0000 L51.0003 55.4999 L55.5001 55.9999 L51.9998 98.0000 M51.9998 98.0000 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(90deg) scaleY(0.97) rotate(-90deg)",
        }}
      />
      <path
        d="M77.5007 86.9997 L77.5007 90.9997 L77.0006 92.4997 L75.0004 93.4997 L71.5006 93.0339 L47.4669 57.2642 L56.9998 50.0002 L64.9994 64.5004 L65.7507 69.7497 L77.5007 86.9997 M77.5007 86.9997 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(60deg) scaleY(1.09055) rotate(-60deg)",
        }}
      />
      <path
        d="M89.0008 80.9991 L89.5008 83.4991 L88.0008 85.4991 L86.5007 84.9991 L78.0007 78.9991 L65.0007 67.4991 L55.0007 60.4991 L58.0000 51.0000 L62.9999 54.0001 L66.0007 59.4991 L89.0008 80.9991 M89.0008 80.9991 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(30deg) scaleY(1.12422) rotate(-30deg)",
        }}
      />
      <path
        d="M82.5003 55.5000 L95.0003 56.5000 L98.0003 58.5000 L100.0000 61.5000 L100.0000 63.6587 L94.5003 66.0000 L66.5005 59.0000 L55.0003 58.5000 L58.0000 48.0000 L66.0005 54.0000 L82.5003 55.5000 M82.5003 55.5000 "
        fill="currentColor"
        style={{
          transformOrigin: "50px 50px",
          transform: "rotate(0deg) scaleY(1.25389) rotate(0deg)",
        }}
      />
    </svg>
  );
}

export function CodexIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-label="ChatGPT"
      className={className}
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

export function GeminiIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  const reactId = useId().replace(/:/g, "");
  const gradientId = `gemini-icon-gradient-${reactId}`;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Gemini"
      className={className}
      {...props}
    >
      <path
        d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="1"
          x2="19"
          y1="13"
          y2="4"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fdd663" />
          <stop offset="0.28" stopColor="#34a853" />
          <stop offset="0.68" stopColor="#4285f4" />
          <stop offset="1" stopColor="#ff5d5d" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function GrokIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      role="img"
      aria-label="Grok"
      className={className}
      {...props}
    >
      <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
    </svg>
  );
}

export type ModelProviderBrand =
  | { kind: "brand"; icon: AiToolBrandIconName }
  | { kind: "image"; src: string }
  | { kind: "generic" };

const PROVIDER_LOGOS: Record<string, string> = {
  minimax: "/provider-logos/minimax.svg",
  "minimax-intl": "/provider-logos/minimax.svg",
  "z-ai": "/provider-logos/zhipuai.svg",
  zhipu: "/provider-logos/zhipuai.svg",
  kimi: "/provider-logos/moonshotai.svg",
  moonshot: "/provider-logos/moonshotai.svg",
  deepseek: "/provider-logos/deepseek.svg",
  meta: "/provider-logos/meta.svg",
};

export function resolveModelProviderBrand({
  model,
  provider,
}: {
  model?: string | null;
  provider?: string | null;
}): ModelProviderBrand {
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  const normalizedProvider = provider?.trim().toLowerCase() ?? "";

  // Model identity wins over the transport/provider. Anthropic-compatible
  // models such as MiniMax must keep their own brand instead of looking like Claude.
  if (normalizedModel.includes("minimax")) {
    return { kind: "image", src: PROVIDER_LOGOS.minimax };
  }
  if (normalizedModel.includes("deepseek")) {
    return { kind: "image", src: PROVIDER_LOGOS.deepseek };
  }
  if (normalizedModel.includes("kimi") || normalizedModel.includes("moonshot")) {
    return { kind: "image", src: PROVIDER_LOGOS.moonshot };
  }
  if (normalizedModel.includes("glm") || normalizedModel.includes("zhipu")) {
    return { kind: "image", src: PROVIDER_LOGOS.zhipu };
  }
  if (normalizedModel.includes("llama") || normalizedModel.includes("meta")) {
    return { kind: "image", src: PROVIDER_LOGOS.meta };
  }
  if (normalizedModel.includes("claude")) return { kind: "brand", icon: "claude" };
  if (normalizedModel.includes("gemini")) return { kind: "brand", icon: "gemini" };
  if (
    normalizedModel.includes("gpt") ||
    normalizedModel.includes("codex") ||
    /^o\d(?:\b|-)/.test(normalizedModel)
  ) {
    return { kind: "brand", icon: "chatgpt" };
  }

  const providerLogo = PROVIDER_LOGOS[normalizedProvider];
  if (providerLogo) return { kind: "image", src: providerLogo };
  if (normalizedProvider.includes("openai")) return { kind: "brand", icon: "chatgpt" };
  if (normalizedProvider.includes("anthropic")) return { kind: "brand", icon: "claude" };
  if (normalizedProvider.includes("google") || normalizedProvider.includes("gemini")) {
    return { kind: "brand", icon: "gemini" };
  }
  return { kind: "generic" };
}

export function ModelProviderIcon({
  model,
  provider,
  className,
  fallback = true,
}: {
  model?: string | null;
  provider?: string | null;
  className?: string;
  fallback?: boolean | "rome";
}) {
  const brand = resolveModelProviderBrand({ model, provider });
  const classes = cn("size-4 shrink-0", className);
  if (brand.kind === "image") {
    return (
      <img
        src={brand.src}
        alt=""
        aria-hidden
        className={cn(classes, "object-contain dark:invert")}
      />
    );
  }
  if (brand.kind === "brand") {
    const color =
      brand.icon === "claude"
        ? "text-[#d97757]"
        : brand.icon === "gemini"
          ? "text-[#4285f4]"
          : "text-foreground";
    return <AiToolBrandIcon icon={brand.icon} aria-hidden className={cn(classes, color)} />;
  }
  if (fallback === "rome") {
    return <RomeLogo aria-hidden className={cn(classes, "text-muted-foreground")} />;
  }
  return fallback ? <Cpu aria-hidden className={cn(classes, "text-muted-foreground")} /> : null;
}
