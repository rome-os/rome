import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppStoreRemixConfirm } from "@/components/AppStoreRemixConfirm";
import { Button } from "@/components/ui/button";
import { APP_REMIX_SKILL, parseRemixSearch, remixSourceDraft } from "@/lib/app-remix";
import { PageShell } from "@/shell/PageShell";

export default function AppRemixConfirmPage() {
  const { t } = useTranslation("apps");
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const intent = parseRemixSearch(search);
  const cancel = () => navigate("/apps", { replace: true });
  return (
    <PageShell>
      <div className="max-w-xl rounded-12 border border-border bg-surface p-6">
        {intent ? (
          <AppStoreRemixConfirm
            intent={intent}
            onCancel={cancel}
            onConfirm={(pin) => {
              navigate("/chat", {
                replace: true,
                state: {
                  skill: APP_REMIX_SKILL,
                  draft: remixSourceDraft(pin, t),
                },
              });
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <p role="alert" className="text-ui text-destructive">
              {t("remixStore.invalidLink")}
            </p>
            <Button variant="outline" onClick={cancel}>
              {t("install.cancel")}
            </Button>
          </div>
        )}
      </div>
    </PageShell>
  );
}
