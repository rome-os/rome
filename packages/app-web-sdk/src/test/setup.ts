// Keep this shared setup environment-safe. Most SDK tests run in Node, while
// browser runtime tests opt into jsdom with an Rstest environment docblock.
export {};
