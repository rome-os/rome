import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { RomeInputDialog } from "@/components/rome-input-dialog";
import { MoveDialog } from "./MoveDialog";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";

export function Dialogs() {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const nameDialog = useFileBrowserStore((s) => s.ui.nameDialog);
  const deleteConfirm = useFileBrowserStore((s) => s.ui.deleteConfirm);
  const discardChangesConfirmOpen = useFileBrowserStore((s) => s.ui.discardChangesConfirmOpen);
  const renderCreateExtra = useFileBrowserStore((s) => s.config.renderCreateExtra);

  useEffect(() => () => store.getState().ui.resolveDiscardChangesConfirm(false), [store]);

  return (
    <>
      {nameDialog && (
        <RomeInputDialog
          open
          title={nameDialog.title}
          description={nameDialog.mode === "create" ? nameDialog.description : undefined}
          inputLabel={nameDialog.inputLabel}
          initialValue={nameDialog.initialValue}
          confirmLabel={nameDialog.confirmLabel}
          error={nameDialog.error}
          onCancel={() => store.getState().ui.setNameDialog(null)}
          onConfirm={(value) => void store.getState().ui.handleNameDialogConfirm(value)}
        >
          {nameDialog.mode === "create" && renderCreateExtra
            ? renderCreateExtra({ type: nameDialog.type, parentPath: nameDialog.parentPath })
            : null}
        </RomeInputDialog>
      )}
      {deleteConfirm && (
        <RomeConfirmDialog
          open
          destructive
          title={deleteConfirm.title}
          description={deleteConfirm.description}
          confirmLabel={t("dialog.deleteConfirm")}
          onCancel={() => store.getState().ui.setDeleteConfirm(null)}
          onConfirm={() => {
            const paths = deleteConfirm.paths;
            store.getState().ui.setDeleteConfirm(null);
            void store.getState().ui.deletePaths(paths);
          }}
        />
      )}
      <MoveDialog />
      <RomeConfirmDialog
        open={discardChangesConfirmOpen}
        destructive
        title={t("dialog.discardChangesTitle")}
        description={t("status.unsavedChangesConfirm")}
        confirmLabel={t("dialog.discardChangesConfirm")}
        onCancel={() => store.getState().ui.resolveDiscardChangesConfirm(false)}
        onConfirm={() => store.getState().ui.resolveDiscardChangesConfirm(true)}
      />
    </>
  );
}
