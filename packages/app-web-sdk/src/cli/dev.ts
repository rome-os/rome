import { createRslib } from "@rslib/core";
import { cleanBackendOutput, copyStaticAssets, createBuildContext } from "./createRslibConfig.js";

export async function runDev(): Promise<void> {
  process.env.NODE_ENV ??= "development";
  const ctx = await createBuildContext({ cwd: process.cwd(), mode: "development" });
  if (!ctx.loaded.yaml.web) {
    throw new Error(`rome: app.yaml is missing "web" section — required when running rome dev`);
  }

  cleanBackendOutput(ctx);
  copyStaticAssets(ctx);
  const rslib = await createRslib({ config: ctx.rslibConfig });
  await rslib.build({ watch: true });
}
