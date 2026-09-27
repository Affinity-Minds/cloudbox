// Owner: WT-0. Sidebar entries; keys are fixed by docs/handoffs/foundation.md.
import {
  Building2,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Server,
  Settings,
  Tag,
  Ticket,
  Users,
} from "lucide-react";

export type NavKey =
  | "overview"
  | "tenants"
  | "fleet"
  | "enrollment"
  | "subscriptions"
  | "plans"
  | "licences"
  | "staff"
  | "audit"
  | "settings";

export type NavItem = {
  key: NavKey;
  title: string;
  to:
    | "/"
    | "/tenants"
    | "/fleet"
    | "/enrollment"
    | "/subscriptions"
    | "/plans"
    | "/licences"
    | "/staff"
    | "/audit"
    | "/settings";
  icon: LucideIcon;
};

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operate",
    items: [
      { key: "overview", title: "Overview", to: "/", icon: LayoutDashboard },
      { key: "tenants", title: "Tenants", to: "/tenants", icon: Building2 },
      { key: "fleet", title: "Fleet", to: "/fleet", icon: Server },
      { key: "enrollment", title: "Enrollment", to: "/enrollment", icon: KeyRound },
      { key: "subscriptions", title: "Subscriptions", to: "/subscriptions", icon: CreditCard },
      { key: "licences", title: "Licence keys", to: "/licences", icon: Ticket }, // WT-14
    ],
  },
  {
    label: "Govern",
    items: [
      { key: "plans", title: "Plans", to: "/plans", icon: Tag },
      { key: "staff", title: "Staff", to: "/staff", icon: Users }, // WT-15
      { key: "audit", title: "Audit log", to: "/audit", icon: ScrollText },
      { key: "settings", title: "Settings", to: "/settings", icon: Settings },
    ],
  },
];
