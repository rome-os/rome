import { createRslib } from "@rslib/core";
import { cleanBackendOutput, copyStaticAssets, createBuildContext } from "./createRslibConfig.js";

export async function runBuild(): Promise<void> {
  process.env.NODE_ENV ??= "production";
  const ctx = await createBuildContext({ cwd: process.cwd(), mode: "production" });

  cleanBackendOutput(ctx);
  const rslib = await createRslib({ config: ctx.rslibConfig });
  await rslib.build();
  copyStaticAssets(ctx);
}
