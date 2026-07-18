import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/icons";

export function PageHeader({ eyebrow, title, description, actions, breadcrumb }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode; breadcrumb?: Array<{ label: string; href?: string }> }) {
  return (
    <header className="page-header">
      {breadcrumb && (
        <nav aria-label="Breadcrumb" className="breadcrumb">
          {breadcrumb.map((item, index) => (
            <span key={`${item.label}-${index}`}>
              {index > 0 && <Icon name="chevron-right" size={14} />}
              {item.href ? <Link href={item.href}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="page-header-row">
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}

