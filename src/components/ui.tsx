"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  CircleAlert,
  Info,
  LoaderCircle,
  SearchX,
  X,
} from "lucide-react";
import {
  Children,
  cloneElement,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TableHTMLAttributes,
} from "react";
import { Icon, type IconName } from "@/components/icons";
import type { HealthTone } from "@/demo-data/control-plane";

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind;
  icon?: IconName;
  children: ReactNode;
};

export function Button({ kind = "secondary", icon, className = "", children, ...props }: ButtonProps) {
  return (
    <button className={`button button-${kind} ${className}`} {...props}>
      {icon && <Icon name={icon} size={18} />}
      <span>{children}</span>
    </button>
  );
}

export function ButtonLink({ href, kind = "secondary", icon, children, className = "" }: { href: string; kind?: ButtonKind; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <Link className={`button button-${kind} ${className}`} href={href}>
      {icon && <Icon name={icon} size={18} />}
      <span>{children}</span>
    </Link>
  );
}

export function IconButton({ label, icon, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName }) {
  return (
    <button aria-label={label} className={`icon-button ${className}`} title={label} {...props}>
      <Icon name={icon} size={20} />
    </button>
  );
}

export function Surface({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return <div className={`surface ${className}`} {...props}>{children}</div>;
}

export function StatusBadge({ children, tone = "neutral", pulse = false }: { children: ReactNode; tone?: HealthTone; pulse?: boolean }) {
  return (
    <span className={`status-badge status-${tone}`}>
      <span className={`status-dot ${pulse ? "is-pulsing" : ""}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function SourceBadge({ mode }: { mode: "fixture" | "import" | "live" }) {
  const labels = { fixture: "Fixture data", import: "Authorized import", live: "Approved live API" };
  return <span className={`source-badge source-${mode}`}><Icon name={mode === "live" ? "activity" : mode === "import" ? "file" : "database"} size={13} />{labels[mode]}</span>;
}

export function Progress({ value, label }: { value: number; label: string }) {
  const boundedValue = Math.min(100, Math.max(0, value));
  return (
    <div className="progress-wrap">
      <div className="progress-meta"><span>{label}</span><strong>{boundedValue}%</strong></div>
      <div aria-label={`${label}: ${boundedValue}%`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={boundedValue} className="progress-track" role="progressbar">
        <span style={{ width: `${boundedValue}%` }} />
      </div>
    </div>
  );
}

export function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: HealthTone }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="section-action">{action}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon: IconName; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={24} /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton ${className}`} />;
}

type AlertTone = "info" | "success" | "warning" | "danger";

const alertIcons = {
  info: Info,
  success: CheckCircle2,
  warning: CircleAlert,
  danger: AlertCircle,
};

export function Alert({
  title,
  children,
  tone = "info",
  onDismiss,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  tone?: AlertTone;
  onDismiss?: () => void;
  className?: string;
}) {
  const AlertIcon = alertIcons[tone];
  return (
    <div className={`alert alert-${tone} ${className}`} role={tone === "danger" ? "alert" : "status"}>
      <AlertIcon aria-hidden="true" className="alert-icon" size={19} strokeWidth={1.9} />
      <div className="alert-copy">
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
      {onDismiss && (
        <button aria-label="Dismiss message" className="alert-dismiss" onClick={onDismiss} type="button">
          <X aria-hidden="true" size={16} />
        </button>
      )}
    </div>
  );
}

type FieldChildProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export function Field({
  label,
  children,
  htmlFor,
  hint,
  error,
  required = false,
  className = "",
}: {
  label: ReactNode;
  children: ReactElement<FieldChildProps>;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
}) {
  const generatedId = useId();
  const controlId = htmlFor ?? `field-${generatedId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ");
  const control = cloneElement(children, {
    id: children.props.id ?? controlId,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true } : {}),
  });

  return (
    <div className={`field ${error ? "has-error" : ""} ${className}`}>
      <label htmlFor={children.props.id ?? controlId}>
        <span>{label}</span>
        {required && <span aria-hidden="true" className="field-required">Required</span>}
      </label>
      {control}
      {hint && <div className="field-hint" id={hintId}>{hint}</div>}
      {error && <div className="field-error" id={errorId} role="alert">{error}</div>}
    </div>
  );
}

type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  trigger?: ReactElement;
  className?: string;
  contentClassName?: string;
  closeLabel?: string;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  trigger,
  className = "",
  contentClassName = "",
  closeLabel = "Close dialog",
  onOpenAutoFocus,
  onCloseAutoFocus,
}: DialogProps) {
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-backdrop" />
        <DialogPrimitive.Content className={`dialog-surface ${contentClassName}`} onCloseAutoFocus={onCloseAutoFocus} onOpenAutoFocus={onOpenAutoFocus}>
          <div className={`dialog-frame ${className}`}>
            <header className="dialog-header">
              <div>
                <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
                {description && <DialogPrimitive.Description>{description}</DialogPrimitive.Description>}
              </div>
              <DialogPrimitive.Close aria-label={closeLabel} className="dialog-close">
                <X aria-hidden="true" size={18} />
              </DialogPrimitive.Close>
            </header>
            <div className="dialog-body">{children}</div>
            {footer && <footer className="dialog-footer">{footer}</footer>}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  trigger,
  className = "",
  side = "right",
  closeLabel = "Close sheet",
}: Omit<DialogProps, "contentClassName"> & { side?: "right" | "bottom" }) {
  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-backdrop sheet-backdrop" />
        <DialogPrimitive.Content className={`sheet-surface sheet-${side}`}>
          <div className={`dialog-frame sheet-frame ${className}`}>
            <header className="dialog-header">
              <div>
                <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
                {description && <DialogPrimitive.Description>{description}</DialogPrimitive.Description>}
              </div>
              <DialogPrimitive.Close aria-label={closeLabel} className="dialog-close">
                <X aria-hidden="true" size={18} />
              </DialogPrimitive.Close>
            </header>
            <div className="dialog-body sheet-body">{children}</div>
            {footer && <footer className="dialog-footer">{footer}</footer>}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export type SegmentedControlOption = {
  value: string;
  label: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
};

export function SegmentedControl({
  label,
  options,
  value,
  onChange,
  className = "",
}: {
  label: string;
  options: readonly SegmentedControlOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div aria-label={label} className={`segmented-control ui-segmented-control ${className}`} role="group">
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={value === option.value ? "is-active" : ""}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          <span className="segment-label">{option.label}</span>
          {option.badge !== undefined && <span className="segment-badge">{option.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatTile({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  return (
    <article className={`stat-tile stat-${tone} ${className}`}>
      <div className="stat-label"><span>{label}</span>{icon && <span className="stat-icon">{icon}</span>}</div>
      <strong className="stat-value">{value}</strong>
      {detail && <div className="stat-detail">{detail}</div>}
    </article>
  );
}

export function DataTable({
  children,
  caption,
  className = "",
  compact = false,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & {
  children: ReactNode;
  caption?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`data-table-shell ${compact ? "is-compact" : ""} ${className}`}>
      <table {...props}>
        {caption && <caption>{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

type TooltipChildProps = { "aria-describedby"?: string };

export function Tooltip({ children, content, side = "top" }: { children: ReactElement<TooltipChildProps>; content: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  const id = `tooltip-${useId()}`;
  const child = Children.only(children);
  const describedBy = [child.props["aria-describedby"], id].filter(Boolean).join(" ");
  return (
    <span className="tooltip-root">
      {cloneElement(child, { "aria-describedby": describedBy })}
      <span className={`tooltip-content tooltip-${side}`} id={id} role="tooltip">{content}</span>
    </span>
  );
}

type PageStateKind = "loading" | "empty" | "error" | "not-found";

const pageStateIcons = {
  loading: LoaderCircle,
  empty: SearchX,
  error: AlertCircle,
  "not-found": SearchX,
};

export function PageState({
  kind,
  title,
  description,
  action,
  className = "",
}: {
  kind: PageStateKind;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  const StateIcon = pageStateIcons[kind];
  return (
    <section aria-busy={kind === "loading"} className={`page-state page-state-${kind} ${className}`}>
      <span className="page-state-icon"><StateIcon aria-hidden="true" size={25} strokeWidth={1.8} /></span>
      <h1>{title}</h1>
      <p>{description}</p>
      {kind === "loading" && <div className="page-state-progress" aria-hidden="true"><span /></div>}
      {action && <div className="page-state-action">{action}</div>}
    </section>
  );
}
