import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import type { LinkCodeResponse } from "@rome/api-types/people";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchJson } from "@/lib/fetch-json";

/**
 * The guardian's shortcut for linking one of their own accounts
 * (docs/domains/people.md#account). Opening the dialog asks for a code, and
 * sending it in a direct message to any of Rome's accounts links the account it
 * came from to them. Each opening shows a new
 * code and voids the last, so the code on screen is always the one that works.
 */
export function LinkMyAccount() {
  const { t } = useTranslation("people");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const issue = useMutation({
    mutationFn: () =>
      fetchJson<LinkCodeResponse>("/api/people/link-code", {
        method: "POST",
        fallback: t("linkCode.failed"),
      }),
  });

  function show() {
    setCopied(false);
    setOpen(true);
    issue.mutate();
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const code = issue.data;
  return (
    <>
      <Button type="button" variant="outline" onClick={show}>
        {t("linkCode.open")}
      </Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} size="md" ariaLabel={t("linkCode.title")}>
          <DialogHeader onClose={() => setOpen(false)} closeLabel={t("actions.close")}>
            <DialogTitle>{t("linkCode.title")}</DialogTitle>
            <DialogDescription>{t("linkCode.description")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {issue.isError ? (
              <p role="alert" className="text-ui text-destructive">
                {issue.error.message}
              </p>
            ) : !code ? (
              <p className="text-ui text-muted-foreground">{t("page.loading")}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-8 bg-surface px-3 py-1 font-mono text-title">
                    {code.code}
                  </code>
                  <Button type="button" variant="outline" onClick={() => void copy(code.code)}>
                    {copied ? (
                      <Check data-icon="inline-start" aria-hidden="true" />
                    ) : (
                      <Copy data-icon="inline-start" aria-hidden="true" />
                    )}
                    {t(copied ? "linkCode.copied" : "linkCode.copy")}
                  </Button>
                </div>
                <p className="text-aux text-muted-foreground">
                  {t("linkCode.expires", {
                    time: new Date(code.expiresAt).toLocaleTimeString(),
                  })}
                </p>
              </>
            )}
          </DialogBody>
        </Dialog>
      )}
    </>
  );
}
