import { createContext, useContext, useMemo, useState } from "react";
import { api, type SessionResponse, type User } from "../lib/api";
import { useShortcuts, type Shortcut } from "../lib/keys";
import { invalidate, useLiveEvents, useResource } from "../lib/resource";
import { navigate, parseRoute, useLocation } from "../lib/router";
import { Spinner } from "../ui/spinner";
import { AuthScreen } from "./Auth";
import { CommandPalette } from "./CommandPalette";
import { Compose } from "./Compose";
import { Inbox } from "./Inbox";
import { Insights } from "./Insights";
import { Playbook } from "./Playbook";
import { Settings } from "./Settings";
import { ShortcutSheet } from "./ShortcutSheet";
import { Sidebar } from "./Sidebar";

type Session = { user: User; demo: boolean; signOut: () => Promise<void>; toggleTheme: () => void; dark: boolean };

const SessionContext = createContext<Session | null>(null);

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside the signed-in app");
  return session;
}

export function App() {
  const session = useResource<SessionResponse>("/api/session");
  if (!session.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        {session.error ? <p className="text-muted-foreground text-sm">{session.error.message}</p> : <Spinner />}
      </div>
    );
  }
  if (!session.data.user) return <AuthScreen session={session.data} onSignedIn={() => void session.reload()} />;
  return <Workspace user={session.data.user} demo={Boolean(session.data.demo)} />;
}

function Workspace({ user, demo }: { user: User; demo: boolean }) {
  const location = useLocation();
  const route = parseRoute(location);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useLiveEvents(true);

  const session = useMemo<Session>(
    () => ({
      user,
      demo,
      dark,
      toggleTheme: () => {
        const next = !document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem("rf-theme", next ? "dark" : "light");
        setDark(next);
      },
      signOut: async () => {
        await api("/api/logout", { method: "POST", body: {} });
        invalidate("/api/session");
        navigate("/");
      },
    }),
    [user, demo, dark],
  );

  const global: Shortcut[] = [
    { keys: "mod+k", label: "Open the command menu", group: "General", run: () => setPaletteOpen((open) => !open), allowInInput: true },
    { keys: "?", label: "Show keyboard shortcuts", group: "General", run: () => setSheetOpen(true) },
    { keys: "c", label: "Write a new email", group: "General", run: () => navigate("/compose") },
    { keys: "g i", label: "Go to the inbox", group: "Go to", run: () => navigate("/inbox/open") },
    { keys: "g m", label: "Go to assigned to me", group: "Go to", run: () => navigate("/inbox/mine") },
    { keys: "g w", label: "Go to waiting on customer", group: "Go to", run: () => navigate("/inbox/waiting") },
    { keys: "g p", label: "Go to the playbook", group: "Go to", run: () => navigate("/playbook") },
    { keys: "g s", label: "Go to insights", group: "Go to", run: () => navigate("/insights") },
    { keys: "g ,", label: "Go to settings", group: "Go to", run: () => navigate("/settings/mailboxes") },
  ];
  useShortcuts(global, !paletteOpen);

  return (
    <SessionContext.Provider value={session}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <Sidebar route={route} onOpenPalette={() => setPaletteOpen(true)} onOpenShortcuts={() => setSheetOpen(true)} />
        <main className="flex min-w-0 flex-1 flex-col">
          {route.page === "inbox" ? <Inbox view={route.view} conversationId={route.conversationId} /> : null}
          {route.page === "compose" ? <Compose /> : null}
          {route.page === "playbook" ? <Playbook /> : null}
          {route.page === "insights" ? <Insights /> : null}
          {route.page === "settings" ? <Settings section={route.section} /> : null}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onShowShortcuts={() => setSheetOpen(true)} />
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} shortcuts={global} />
    </SessionContext.Provider>
  );
}
