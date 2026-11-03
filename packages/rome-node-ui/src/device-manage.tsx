import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@rome-os/ui/button";
import { cn } from "@rome-os/ui/cn";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rome-os/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rome-os/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel, FormError } from "@rome-os/ui/field";
import { IconButton } from "@rome-os/ui/icon-button";
import { Input } from "@rome-os/ui/input";
import { Ellipsis, ExternalLink, Pencil, Plug, Trash2, Unplug } from "lucide-react";
import { format, type NodeUiMessages } from "./messages.js";
import type {
  NodeDevice,
  NodeDeviceManage,
  NodeDeviceManageError,
  NodeThisDevice,
} from "./types.js";

type Open = "rename" | "disconnect" | "remove" | null;

/**
 * A device's actions menu, on its card and on its page.
 *
 * Another device: rename, and remove, which revokes it and deletes it from the account in one
 * step. A device whose revocation Rome Cloud has not confirmed yet stays listed as revoked, and
 * removing it again deletes it.
 * This computer: rename, and connect or disconnect through the app, which can be undone at any
 * time. It is removed on Rome Cloud, so the menu only points there.
 * Renders nothing when it has no action to offer.
 */
export function DeviceMenu({
  device,
  self,
  manage,
  m,
}: {
  device: NodeDevice;
  self?: NodeThisDevice;
  manage?: NodeDeviceManage;
  m: NodeUiMessages;
}) {
  const [open, setOpen] = useState<Open>(null);
  const revoked = device.status === "revoked";
  if (!manage && !self) return null;
  const close = () => setOpen(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={m.manage.menu} icon={<Ellipsis />} size="sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {manage && !revoked && (
            <DropdownMenuItem onSelect={() => setOpen("rename")}>
              <Pencil className="size-4" aria-hidden />
              {m.manage.rename}
            </DropdownMenuItem>
          )}
          {self ? (
            <>
              {self.state === "disabled" ? (
                <DropdownMenuItem disabled={self.busy} onSelect={() => self.onEnabledChange(true)}>
                  <Plug className="size-4" aria-hidden />
                  {m.manage.connect}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={self.busy}
                  onSelect={() => setOpen("disconnect")}
                >
                  <Unplug className="size-4" aria-hidden />
                  {m.manage.disconnect}
                </DropdownMenuItem>
              )}
              {self.removeUrl && (
                <DropdownMenuItem asChild className="text-primary [&_svg]:text-primary">
                  <a href={self.removeUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-4" aria-hidden />
                    {m.manage.removeOnCloud}
                  </a>
                </DropdownMenuItem>
              )}
            </>
          ) : (
            manage && (
              <DropdownMenuItem variant="destructive" onSelect={() => setOpen("remove")}>
                <Trash2 className="size-4" aria-hidden />
                {m.manage.remove}
              </DropdownMenuItem>
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {open === "rename" && manage && (
        <RenameDialog device={device} manage={manage} m={m} onClose={close} />
      )}
      {open === "disconnect" && self && (
        <ConfirmDialog
          title={format(m.manage.disconnectTitle, { name: device.name })}
          body={m.manage.disconnectSelf}
          action={m.manage.disconnect}
          destructive
          m={m}
          onClose={close}
          request={async () => {
            self.onEnabledChange(false);
            return null;
          }}
        />
      )}
      {open === "remove" && manage && (
        <ConfirmDialog
          icon={<Trash2 aria-hidden />}
          title={format(m.manage.removeTitle, { name: device.name })}
          body={m.manage.removeLead}
          points={(revoked ? m.manage.removeRevoked : m.manage.removeActive).map((point) =>
            format(point, { name: device.name }),
          )}
          action={m.manage.remove}
          destructive
          m={m}
          onClose={close}
          request={() => manage.remove(device.id)}
        />
      )}
    </>
  );
}

function useSubmit(m: NodeUiMessages, request: () => Promise<NodeDeviceManageError | null>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const code = await request().catch((): NodeDeviceManageError => "unavailable");
    setBusy(false);
    if (code) setError(m.manage.errors[code]);
    return code === null;
  };
  return { busy, error, submit };
}

function RenameDialog({
  device,
  manage,
  m,
  onClose,
}: {
  device: NodeDevice;
  manage: NodeDeviceManage;
  m: NodeUiMessages;
  onClose(): void;
}) {
  const id = useId();
  const [name, setName] = useState(device.name);
  const trimmed = name.trim();
  const { busy, error, submit } = useSubmit(m, () => manage.rename(device.id, trimmed));
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === device.name) return onClose();
    if (await submit()) onClose();
  };
  return (
    <Dialog open onClose={onClose} size="sm">
      <form onSubmit={(event) => void onSubmit(event)}>
        <DialogHeader>
          <DialogTitle>{m.manage.renameTitle}</DialogTitle>
          <DialogDescription className="sr-only">{device.name}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <FieldLabel htmlFor={id}>{m.manage.nameLabel}</FieldLabel>
            <Input
              id={id}
              value={name}
              maxLength={80}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>{m.manage.nameHint}</FieldDescription>
            {error && <FormError>{error}</FormError>}
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {m.manage.cancel}
          </Button>
          <Button type="submit" disabled={busy || !trimmed}>
            {m.manage.save}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Asks before an action and closes once it succeeds. A failure stays open with its reason. */
function ConfirmDialog({
  icon,
  title,
  body,
  points,
  action,
  destructive = false,
  m,
  onClose,
  request,
}: {
  /** Drawn above the title, tinted like the action. */
  icon?: ReactNode;
  title: string;
  body: string;
  /** Listed under `body`, one consequence each. */
  points?: string[];
  action: string;
  destructive?: boolean;
  m: NodeUiMessages;
  onClose(): void;
  request(): Promise<NodeDeviceManageError | null>;
}) {
  const { busy, error, submit } = useSubmit(m, request);
  return (
    <Dialog open onClose={onClose} size="sm">
      <DialogHeader>
        {icon && (
          <span
            className={cn(
              "mb-2 flex size-10 items-center justify-center rounded-full [&_svg]:size-5",
              destructive ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground",
            )}
          >
            {icon}
          </span>
        )}
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className={cn(points && "text-foreground")}>{body}</DialogDescription>
      </DialogHeader>
      {(points || error) && (
        <DialogBody className="space-y-3">
          {points && (
            <ul className="list-disc space-y-1 pl-5 text-ui text-muted-foreground">
              {points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          )}
          {error && <FormError>{error}</FormError>}
        </DialogBody>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {m.manage.cancel}
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          disabled={busy}
          onClick={() => void submit().then((done) => done && onClose())}
        >
          {action}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
