// Barrel export for the kit. Components land here as they move in from the
// dashboard; each also gets its own subpath export (`@rome-os/ui/button`) so
// consumers can avoid pulling the whole kit into a bundle.
//
// Components backed by optional peers are deliberately absent. Re-exporting
// Markdown (Streamdown), Calendar (react-day-picker), Command (cmdk), or Sonner
// would make every barrel import — `import { Button } from "@rome-os/ui"` — fail
// to resolve for a consumer that never installed those peers. They remain
// subpath-only.
export { cn, type ClassValue } from "./cn.js";
export { Alert, AlertDescription, AlertTitle, type AlertProps } from "./alert.js";
export {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./avatar.js";
export { Badge, type BadgeProps } from "./badge.js";
export {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./breadcrumb.js";
export { Button, buttonVariants } from "./button.js";
export {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
  buttonGroupVariants,
} from "./button-group.js";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card.js";
export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./context-menu.js";
export {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type DialogHeaderProps,
  type DialogProps,
} from "./dialog.js";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  dropdownMenuItemVariants,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";
export {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  type EmptyStateProps,
} from "./empty-state.js";
export {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldGroupLabel,
  FieldLabel,
  FormError,
} from "./field.js";
export {
  FilterChipGroup,
  type FilterChipGroupProps,
  type FilterChipOption,
} from "./filter-chip-group.js";
export { IconButton, type IconButtonProps } from "./icon-button.js";
export { Input } from "./input.js";
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover.js";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  type SelectTriggerProps,
  SelectValue,
} from "./select.js";
export {
  SegmentedControl,
  type SegmentedControlOption,
  type SegmentedControlProps,
} from "./segmented-control.js";
export { Separator } from "./separator.js";
export { Sheet, SheetDescription, SheetTitle, type SheetProps } from "./sheet.js";
export { Skeleton } from "./skeleton.js";
export { Spinner, type SpinnerProps } from "./spinner.js";
export { Switch } from "./switch.js";
export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.js";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";
export { Textarea } from "./textarea.js";
export {
  formatTimestamp,
  Timestamp,
  TimestampProvider,
  useTimestampSettings,
  type FormatTimestampOptions,
  type ResolvedTimestampSettings,
  type TimestampFormat,
  type TimestampPreset,
  type TimestampProps,
  type TimestampProviderProps,
  type TimestampSettings,
  type TimestampValue,
} from "./timestamp.js";
export { Toggle, type ToggleProps } from "./toggle.js";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";
