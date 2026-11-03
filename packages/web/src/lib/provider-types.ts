export interface ComposioCliStatus {
  installed: boolean;
  loggedIn: boolean;
  loginPending: boolean;
  webUrl: string | null;
  orgId: string | null;
  testUserId: string | null;
  error: string | null;
}
