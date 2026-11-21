import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const helper = fileURLToPath(
    new URL("../../rome-node-core/dist/native/Rome Computer Use.app", import.meta.url),
  );
  const executable = `${helper}/Contents/MacOS/RomeComputerUse`;
  if (!statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "Build the macOS computer-use helper before packaging Rome: pnpm --filter @rome-os/node-core build:native --identity <identity>",
    );
  }
  const result = spawnSync("/usr/bin/codesign", ["--verify", "--strict", helper], {
    encoding: "utf8",
  });
  if (result.status !== 0 && process.env.ROME_DESKTOP_ALLOW_UNSIGNED_COMPUTER_USE !== "1") {
    throw new Error(`The computer-use helper needs a valid stable signature: ${result.stderr}`);
  }
  if (process.env.ROME_DESKTOP_ALLOW_UNSIGNED_COMPUTER_USE !== "1") {
    const signature = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", helper], {
      encoding: "utf8",
    });
    if (
      signature.status !== 0 ||
      !/^Authority=(Apple Development:|Developer ID Application:)/m.test(signature.stderr)
    ) {
      throw new Error(
        "Use an Apple Development or Developer ID Application identity for the computer-use helper. Ad-hoc signatures lose privacy permissions across builds.",
      );
    }
  }
}
