import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePrepareRoutineDetailNavigation } from "@/hooks/use-routines";

export function RoutineCreatedCard({
  routineId,
  routineName,
}: {
  routineId: string;
  routineName: string;
}) {
  const { t } = useTranslation("routines");
  const prepareNavigation = usePrepareRoutineDetailNavigation();
  return (
    <div className="mb-3 overflow-hidden rounded-12 border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-muted px-4 py-2">
        <Badge variant="success">
          <Check aria-hidden />
          {t("created.badge")}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="min-w-0 flex-1 text-ui text-foreground">
          {t("created.confirmation", { name: routineName })}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to={`/routines/${encodeURIComponent(routineId)}`} onClick={prepareNavigation}>
            {t("detail.runHistory")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
