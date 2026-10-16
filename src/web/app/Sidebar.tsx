import {
  BookOpenIcon,
  ChartColumnIcon,
  CircleCheckIcon,
  ClockIcon,
  InboxIcon,
  KeyboardIcon,
  LogOutIcon,
  MoonIcon,
  PenSquareIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { InboxResponse, MailboxesResponse } from "../lib/api";
import { useResource } from "../lib/resource";
import { Link, type Route } from "../lib/router";
import { cn } from "../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { useSession } from "./App";
import { Hotkey, Person } from "./common";
import { LogoMark } from "./Logo";

function NavItem({ href, icon, label, count, active, hotkey }: { href: string; icon: ReactNode; label: string; count?: number; active: boolean; hotkey?: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-7 items-center gap-2.5 rounded-md px-2 text-[0.875rem] text-foreground/72 outline-none transition-colors duration-100",
        "hover:bg-foreground/[0.045] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-foreground/[0.06] font-medium text-foreground",
      )}
    >
      <span className={cn("text-muted-foreground [&>svg]:size-4", active && "text-foreground")}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hotkey ? <Hotkey keys={hotkey} className="opacity-0 transition-opacity group-hover:opacity-100" /> : null}
      {count ? <span className="tabular text-muted-foreground text-xs">{count}</span> : null}
    </Link>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-px">
      {title ? <p className="px-2 pt-4 pb-1 font-medium text-muted-foreground text-xs">{title}</p> : null}
      {children}
    </div>
  );
}

export function Sidebar({ route, onOpenPalette, onOpenShortcuts }: { route: Route; onOpenPalette: () => void; onOpenShortcuts: () => void }) {
  const { user, signOut, toggleTheme, dark } = useSession();
  const inbox = useResource<InboxResponse>(route.page === "inbox" ? `/api/inbox?view=${route.view}` : "/api/inbox?view=open");
  const mailboxes = useResource<MailboxesResponse>("/api/mailboxes");
  const counts = inbox.data?.counts;
  const view = route.page === "inbox" ? route.view : null;
  const primary = mailboxes.data?.mailboxes[0];

  return (
    <aside className="hidden w-58 shrink-0 flex-col border-r bg-sidebar px-2.5 pb-2.5 md:flex">
      <div className="flex h-12 items-center gap-2 px-1.5">
        <LogoMark className="size-5" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-medium text-[0.875rem]">{primary?.displayName ?? "Replyfold"}</p>
          <p className="truncate text-muted-foreground text-xs">{primary?.address ?? "No mailbox connected"}</p>
        </div>
      </div>

      <div className="flex gap-1.5 pb-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className="pressable flex h-7 flex-1 items-center gap-2 rounded-md border bg-background px-2 text-muted-foreground text-sm shadow-xs/5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SearchIcon className="size-3.5" />
          <span className="flex-1 text-left">Search</span>
          <Hotkey keys="mod+k" />
        </button>
        <Link
          href="/compose"
          aria-label="Write a new email"
          title="Write a new email (C)"
          className="pressable flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-xs/5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PenSquareIcon className="size-3.5" />
        </Link>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Section>
          <NavItem href="/inbox/mine" icon={<UserIcon />} label="Assigned to me" count={counts?.mine} active={view === "mine"} />
          <NavItem href="/inbox/open" icon={<InboxIcon />} label="Open" count={counts?.open} active={view === "open"} />
          <NavItem href="/inbox/unassigned" icon={<UsersIcon />} label="Unassigned" count={counts?.unassigned} active={view === "unassigned"} />
          <NavItem href="/inbox/waiting" icon={<ClockIcon />} label="Waiting on customer" count={counts?.waiting} active={view === "waiting"} />
          <NavItem href="/inbox/closed" icon={<CircleCheckIcon />} label="Closed" active={view === "closed"} />
        </Section>
        <Section title="Workspace">
          <NavItem href="/playbook" icon={<BookOpenIcon />} label="Playbook" active={route.page === "playbook"} />
          <NavItem href="/insights" icon={<ChartColumnIcon />} label="Insights" active={route.page === "insights"} />
          <NavItem href="/settings/mailboxes" icon={<SettingsIcon />} label="Settings" active={route.page === "settings"} />
        </Section>
      </nav>

      <Menu>
        <MenuTrigger className="flex h-9 items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-foreground/[0.045] focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-foreground/[0.06]">
          <Person name={user.name} seed={user.id} size="md" />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate font-medium text-[0.875rem]">{user.name}</span>
            <span className="block truncate text-muted-foreground text-xs capitalize">{user.role}</span>
          </span>
        </MenuTrigger>
        <MenuPopup side="top" align="start" className="w-56">
          <MenuItem render={<Link href="/settings/profile" />}>
            <UserIcon />
            Profile and signature
          </MenuItem>
          <MenuItem onClick={toggleTheme}>
            {dark ? <SunIcon /> : <MoonIcon />}
            {dark ? "Light theme" : "Dark theme"}
          </MenuItem>
          <MenuItem onClick={onOpenShortcuts}>
            <KeyboardIcon />
            Keyboard shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => void signOut()}>
            <LogOutIcon />
            Sign out
          </MenuItem>
        </MenuPopup>
      </Menu>
    </aside>
  );
}
