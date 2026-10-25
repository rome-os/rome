import { pairingPayload } from "@rome/api-types/approvals";
import type { Approval } from "@/pages/ActivityPage";
import { useApprovals } from "@/hooks/use-approvals";
import { ApprovalHistoryControl, PairingRequestCard } from "./pairing/pairing-views";
import { pairingPresentation } from "./pairing/pairing-presentation";

/** A stored pairing request, as history. Rome resolves none
 *  (docs/domains/people.md#stranger). */
export function PairingApproval({ approval }: { approval: Approval }) {
  const payload = pairingPayload(approval);
  if (!payload) return null;
  return <PairingRequestCard {...pairingPresentation(approval, payload)} />;
}

export function ApprovalHistoryButton() {
  const query = useApprovals();
  return (
    <ApprovalHistoryControl
      hasMore={!!query.hasNextPage}
      loading={query.isFetchingNextPage}
      error={query.isFetchNextPageError}
      onLoad={() => void query.fetchNextPage()}
    />
  );
}
