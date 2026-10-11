import { Parser } from "tar";

export async function readArchivePaths(response: Response): Promise<string[]> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const paths: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry) => {
        paths.push(entry.path);
        entry.resume();
      },
    });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(bytes);
  });
  return paths.sort();
}
