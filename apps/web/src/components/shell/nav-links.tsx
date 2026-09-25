"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { resolveActiveNavHref } from "./nav-active";

export interface NavItem {
  href: string;
  label: string;
}

export function NavLinks({ items, ariaLabel }: { items: NavItem[]; ariaLabel: string }) {
  const pathname = usePathname();
  const activeHref = resolveActiveNavHref(pathname);

  return (
    <nav aria-label={ariaLabel} className="flex items-center gap-2">
      {items.map((item) => {
        const active = item.href === activeHref;
        return (
          <Button key={item.href} asChild variant={active ? "secondary" : "outline"} size="sm" className="kh-nav-item">
            <Link href={item.href} aria-current={active ? "page" : undefined}>
              {item.label}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
