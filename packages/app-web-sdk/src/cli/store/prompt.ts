import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// Prompt without echoing. When stdin is not a TTY (e.g., piped), reads it to
// EOF instead, which lets `--password-stdin` style usage work.
export async function promptSecret(question: string): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
  }

  return new Promise((resolve, reject) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (ch === "") {
          cleanup();
          output.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
    };
    input.on("data", onData);
  });
}
