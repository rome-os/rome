import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import ts from "typescript";

describe("AI tool refresh wiring", () => {
  it("does not attach AI tool probes to turn-finished listeners for either provider", () => {
    // Inspect the composition root without starting its server or provider processes.
    const source = ts.createSourceFile(
      "index.ts",
      readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const listenersUsingAIToolState: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "lifecycleDispatcher" &&
        node.expression.name.text === "onFinished"
      ) {
        const inspect = (child: ts.Node): void => {
          if (ts.isIdentifier(child) && child.text === "aiToolState") {
            listenersUsingAIToolState.push(node.getText(source));
          }
          ts.forEachChild(child, inspect);
        };
        for (const argument of node.arguments) inspect(argument);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(listenersUsingAIToolState).toEqual([]);
  });
});
