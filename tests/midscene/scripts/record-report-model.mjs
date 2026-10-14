#!/usr/bin/env node
// Record which Midscene model produced a suite's report, so the run Summary
// can name it. Both suite jobs run this before uploading their artifact.

import { mkdir, writeFile } from "node:fs/promises";

await mkdir("midscene_run", { recursive: true });
await writeFile(
  "midscene_run/model.json",
  `${JSON.stringify(
    {
      modelName: process.env.MIDSCENE_MODEL_NAME,
      modelFamily: process.env.MIDSCENE_MODEL_FAMILY,
    },
    null,
    2,
  )}\n`,
);
