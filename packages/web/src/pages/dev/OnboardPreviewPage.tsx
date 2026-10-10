import OnboardPage from "../OnboardPage";
import { BootstrapPreview } from "./BootstrapPreview";

// The real OnboardPage. `needs-account` is the only phase that renders it: a
// local-first box with no seat yet. Creating the account finishes setup, so
// there is no second step to preview.
export default function OnboardPreviewPage() {
  return (
    <BootstrapPreview bootstrap={{ phase: "needs-account" }}>
      <OnboardPage />
    </BootstrapPreview>
  );
}
