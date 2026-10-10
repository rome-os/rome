// Entry policy shared by the owner Projects routes and shared-project views.
//
// Dependency trees are skipped at every level of the Projects browser: as
// project roots, in the tree, in live updates, uploads, and folder downloads.
// Build outputs (`build`, `coverage`, `dist`) are real project content and stay
// visible. Dot entries are always skipped by the file browser itself.
export const PROJECTS_IGNORED_NAMES: readonly string[] = ["node_modules"];

// Search still omits generated and dependency content.
export const PROJECTS_SEARCH_GLOBS: readonly string[] = [
  "!**/.git/**",
  "!**/.next/**",
  "!**/.turbo/**",
  "!**/build/**",
  "!**/coverage/**",
  "!**/dist/**",
  "!**/node_modules/**",
];
