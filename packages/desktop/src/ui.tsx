import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Dialog as DialogPrimitive,
  AlertDialog,
  Popover,
  Tooltip,
  DropdownMenu,
  Tabs,
  Select as SelectPrimitive,
} from "radix-ui";
import { Check, ChevronRight, ChevronDown, LoaderCircle, X, type LucideIcon } from "lucide-react";

type ButtonVariant = "neutral" | "accent" | "ghost" | "danger";
export type ButtonProps = ComponentProps<"button"> & {
  size?: "sm" | "md" | "lg";
  loading?: boolean;
} & ({ variant: "tinted"; tint: string } | { variant?: ButtonVariant; tint?: string });

export function Icon({
  component: Component,
  className = "",
}: {
  component: LucideIcon;
  className?: string;
}) {
  return <Component aria-hidden="true" className={`icon ${className}`} />;
}

/** Native form/submitter semantics; decoration never changes the operation. */
export function Button({
  variant = "neutral",
  size = "md",
  type = "button",
  loading = false,
  disabled,
  tint,
  style,
  className = "",
  children,
  ...props
}: ButtonProps) {
  const pressed = props["aria-pressed"];
  const selectable = variant !== "ghost" && pressed !== undefined;
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`control control-${variant} control-${size} ${variant === "tinted" || variant === "danger" ? "control-tinted" : ""} ${className}`}
      style={tint ? ({ ...style, "--button-tint": tint } as CSSProperties) : style}
    >
      {loading && <Icon component={LoaderCircle} className="loading-icon" />}
      {selectable && (
        <Icon
          component={Check}
          className={`choice-check ${pressed === true || pressed === "true" ? "" : "choice-check-hidden"}`}
        />
      )}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  label: string;
  icon: LucideIcon;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button
          variant="ghost"
          {...props}
          className={`icon-control ${props.className ?? ""}`}
          aria-label={label}
        >
          <Icon component={icon} />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input className={`input ${className}`} {...props} />;
}
export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea className={`input ${className}`} {...props} />;
}
const selectKey = (value: string | number) => `value:${value}`;
type SelectProps = Omit<ComponentProps<"button">, "value" | "defaultValue" | "onChange"> & {
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
};
export function Select({
  value,
  defaultValue = "",
  onValueChange,
  name,
  disabled,
  children,
  className = "",
  form,
  ...props
}: SelectProps) {
  const [localValue, setLocalValue] = useState(String(defaultValue));
  const selected = value === undefined ? localValue : String(value);
  return (
    <>
      {name && <input type="hidden" name={name} form={form} value={selected} disabled={disabled} />}
      <SelectPrimitive.Root
        value={selectKey(selected)}
        disabled={disabled ?? false}
        onValueChange={(next) => {
          const decoded = next.slice("value:".length);
          if (value === undefined) setLocalValue(decoded);
          onValueChange?.(decoded);
        }}
      >
        <SelectPrimitive.Trigger
          {...props}
          className={`input model-select ${className}`}
          data-value={selected}
          data-name={name}
        >
          <SelectPrimitive.Value />
          <SelectPrimitive.Icon>
            <ChevronDown size={12} aria-hidden="true" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content className="menu model-menu" position="popper" sideOffset={4}>
            <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </>
  );
}
export function SelectItem({
  value,
  children,
  disabled,
}: {
  value: string | number;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <SelectPrimitive.Item
      className="menu-item"
      value={selectKey(value)}
      data-value={String(value)}
      disabled={disabled ?? false}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <Check size={12} aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
export function Checkbox({ className = "", ...props }: Omit<ComponentProps<"input">, "type">) {
  return <input type="checkbox" className={`native-check ${className}`} {...props} />;
}
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={`${id}-input`}>
        {label}
      </label>
      {children({
        id: `${id}-input`,
        "aria-describedby": hint || error ? id : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {(error || hint) && (
        <span id={id} className={error ? "field-error" : "field-hint"}>
          {error || hint}
        </span>
      )}
    </div>
  );
}

export function PopoverControl({
  trigger,
  label,
  children,
  side = "bottom",
  align = "end",
  onOpenChange,
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  side?: ComponentProps<typeof Popover.Content>["side"];
  align?: ComponentProps<typeof Popover.Content>["align"];
  onOpenChange?: ComponentProps<typeof Popover.Root>["onOpenChange"];
}) {
  return (
    <Popover.Root {...(onOpenChange ? { onOpenChange } : {})}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover"
          side={side}
          align={align}
          sideOffset={10}
          collisionPadding={14}
          aria-label={label}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function DialogContent({
  children,
  className = "",
  style,
  maxWidth = "700px",
  returnFocusRef,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  maxWidth?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="overlay" />
      <DialogPrimitive.Content
        {...props}
        className={`dialog ${className}`}
        style={{ ...style, maxWidth }}
        onInteractOutside={(event) => {
          // Window controls and dragging remain usable without dismissing a modal.
          if (
            event.target instanceof Element &&
            event.target.closest("[data-window-chrome], [data-tauri-plugin-decoration-root]")
          ) {
            event.preventDefault();
          }
          props.onInteractOutside?.(event);
        }}
        onOpenAutoFocus={(event) => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          props.onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          props.onCloseAutoFocus?.(event);
          if (!event.defaultPrevented) {
            event.preventDefault();
            (returnFocusRef?.current ?? returnFocus.current)?.focus();
          }
        }}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <IconButton label="Close dialog" icon={X} className="dialog-close" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
export const Dialog = {
  Root: DialogPrimitive.Root,
  Trigger: DialogPrimitive.Trigger,
  Content: DialogContent,
  Title: (props: ComponentProps<typeof DialogPrimitive.Title>) => (
    <DialogPrimitive.Title {...props} className={`dialog-title ${props.className ?? ""}`} />
  ),
  Description: (props: ComponentProps<typeof DialogPrimitive.Description>) => (
    <DialogPrimitive.Description
      {...props}
      className={`dialog-description ${props.className ?? ""}`}
    />
  ),
  Close: (props: ComponentProps<typeof DialogPrimitive.Close>) => (
    <DialogPrimitive.Close asChild {...props} />
  ),
};

/** Screen owners capture the exact pending operation before showing this dialog. */
export function Confirmation({
  title,
  description,
  open,
  onOpenChange,
  onConfirm,
  confirmLabel = "Continue",
  returnFocusRef,
  acceptedFocusRef,
}: {
  title: string;
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  confirmLabel?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  acceptedFocusRef?: RefObject<HTMLElement | null>;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const accepted = useRef(false);
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content
          className="dialog confirmation"
          onOpenAutoFocus={() => {
            accepted.current = false;
            returnFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            // Owners provide a retained target when the opener unmounts or becomes disabled.
            event.preventDefault();
            (
              (accepted.current ? acceptedFocusRef?.current : undefined) ??
              returnFocusRef?.current ??
              returnFocus.current
            )?.focus();
          }}
        >
          <AlertDialog.Title className="dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-description">
            {description}
          </AlertDialog.Description>
          <div className="button-row">
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="danger"
                onClick={() => {
                  accepted.current = true;
                  onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
export function Disclosure({
  title,
  children,
  className = "",
  ...props
}: Omit<ComponentProps<"details">, "title"> & { title: ReactNode }) {
  return (
    <details {...props} className={`disclosure ${className}`}>
      <summary>
        <Icon component={ChevronRight} className="disclosure-chevron" />
        {title}
      </summary>
      {children}
    </details>
  );
}
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="specimen-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
export { Tooltip, Popover, DropdownMenu, Tabs };
