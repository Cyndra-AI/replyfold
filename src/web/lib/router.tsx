import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

window.addEventListener("popstate", emit);

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  emit();
}

export function useLocation() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => location.pathname + location.search,
  );
}

export type Route =
  | { page: "inbox"; view: string; conversationId: string | null }
  | { page: "compose" }
  | { page: "playbook" }
  | { page: "insights" }
  | { page: "settings"; section: "mailboxes" | "ai" | "team" | "profile" };

const VIEWS = new Set(["mine", "unassigned", "open", "waiting", "closed", "all"]);

export function parseRoute(path: string): Route {
  const [pathname = "/"] = path.split("?");
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "compose") return { page: "compose" };
  if (parts[0] === "playbook") return { page: "playbook" };
  if (parts[0] === "insights") return { page: "insights" };
  if (parts[0] === "settings") {
    const section = parts[1] === "team" || parts[1] === "profile" || parts[1] === "ai" ? parts[1] : "mailboxes";
    return { page: "settings", section };
  }
  const view = parts[0] === "inbox" && parts[1] && VIEWS.has(parts[1]) ? parts[1] : "open";
  return { page: "inbox", view, conversationId: parts[0] === "inbox" ? (parts[2] ?? null) : null };
}

export function Link(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(props.href);
      }}
    />
  );
}
