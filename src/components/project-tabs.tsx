"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/icons";

const tabs: Array<{ slug: string; label: string; icon: IconName }> = [
  { slug: "", label: "Conversation", icon: "chat" },
  { slug: "/overview", label: "Overview", icon: "activity" },
  { slug: "/evidence", label: "Evidence", icon: "search" },
  { slug: "/spec", label: "Product spec", icon: "file" },
  { slug: "/builds", label: "Builds", icon: "terminal" },
  { slug: "/releases", label: "Releases", icon: "globe" },
  { slug: "/settings", label: "Settings", icon: "settings" },
];

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  return (
    <nav aria-label="Project sections" className="project-tabs">
      <div className="project-tabs-scroll">
        {tabs.map((tab) => {
          const href = `${base}${tab.slug}`;
          const active = tab.slug ? pathname.startsWith(href) : pathname === base;
          return (
            <Link aria-current={active ? "page" : undefined} className={active ? "is-active" : ""} href={href} key={tab.label}>
              <Icon name={tab.icon} size={16} />
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

