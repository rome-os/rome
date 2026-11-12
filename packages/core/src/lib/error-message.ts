/** The message of a failed CLI command, or a stand-in when it threw something other than an `Error`. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Command failed";
}
