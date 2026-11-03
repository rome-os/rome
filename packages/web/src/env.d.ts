declare module "*.svg?react" {
  import type { FunctionComponent, SVGProps } from "react";
  const ReactComponent: FunctionComponent<SVGProps<SVGSVGElement> & { title?: string }>;
  export default ReactComponent;
}

interface ImportMetaEnv {
  // Baked in by rsbuild at build time from PANTHEON_BASE_ORIGIN /
  // PANTHEON_DOMAIN. Used as the base for the external "Browse App Store"
  // link. Guaranteed to be present (build fails otherwise).
  readonly ROME_CLOUD_ORIGIN: string;
  readonly ROME_MOCK_STRICT_E2E: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
