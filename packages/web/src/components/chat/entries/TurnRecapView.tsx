import { TurnSummaryGroup, type TurnRecapSummary } from "@/components/chat/TurnSummaryGroup";

export type TurnRecapViewProps = TurnRecapSummary;

export function TurnRecapView({
  content,
  audioUrl,
  audioMimeType,
  audioDurationMs,
}: TurnRecapViewProps) {
  return (
    <TurnSummaryGroup recap={{ content, audioUrl, audioMimeType, audioDurationMs }} live={false} />
  );
}
