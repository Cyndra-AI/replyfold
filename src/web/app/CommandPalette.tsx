import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { InboxResponse } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useResource } from "../lib/resource";
import { navigate } from "../lib/router";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "../ui/command";
import { Kbd, KbdGroup } from "../ui/kbd";
import { useSession } from "./App";
import { keyLabel } from "../lib/keys";

type Item = { value: string; label: string; hint?: string; keys?: string; run: () => void };
type Group = { value: string; items: Item[] };

function matches(item: unknown, text: string) {
  if (typeof item !== "object" || item === null || !("value" in item) || typeof item.value !== "string") return false;
  const query = text.trim().toLowerCase();
  return item.value.startsWith("conversation ") || !query || item.value.toLowerCase().includes(query);
}

export function CommandPalette({ open, onOpenChange, onShowShortcuts }: { open: boolean; onOpenChange: (open: boolean) => void; onShowShortcuts: () => void }) {
  const { toggleTheme, dark } = useSession();
  const [query, setQuery] = useState("");
  const search = useResource<InboxResponse>(open && query.trim().length > 1 ? `/api/inbox?view=all&q=${encodeURIComponent(query.trim())}` : null);
  const recent = useResource<InboxResponse>(open ? "/api/inbox?view=open" : null);

  const groups = useMemo<Group[]>(() => {
    const go = (to: string) => () => navigate(to);
    const conversations = (query.trim().length > 1 ? search.data?.conversations : recent.data?.conversations)?.slice(0, 6) ?? [];
    return [
      {
        value: query.trim().length > 1 ? "Conversations" : "Recent conversations",
        items: conversations.map((conversation) => ({
          value: `conversation ${conversation.id} ${conversation.subject} ${conversation.customer.name} ${conversation.customer.email}`,
          label: conversation.subject,
          hint: `${conversation.customer.name || conversation.customer.email}, ${relativeTime(conversation.lastMessageAt)}`,
          run: go(`/inbox/all/${conversation.id}`),
        })),
      },
      {
        value: "Go to",
        items: [
          { value: "go to open conversations inbox", label: "Open conversations", keys: "g i", run: go("/inbox/open") },
          { value: "go to assigned to me mine", label: "Assigned to me", keys: "g m", run: go("/inbox/mine") },
          { value: "go to waiting on customer", label: "Waiting on customer", keys: "g w", run: go("/inbox/waiting") },
          { value: "go to playbook", label: "Playbook", keys: "g p", run: go("/playbook") },
          { value: "go to insights statistics", label: "Insights", keys: "g s", run: go("/insights") },
          { value: "go to mailboxes settings", label: "Mailboxes", keys: "g ,", run: go("/settings/mailboxes") },
          { value: "go to team", label: "Team", run: go("/settings/team") },
          { value: "ai model chatgpt api key openrouter anthropic gemini classification mood jev", label: "AI and classification", run: go("/settings/ai") },
        ],
      },
      {
        value: "Actions",
        items: [
          { value: "write a new email compose", label: "Write a new email", keys: "c", run: go("/compose") },
          { value: "connect a mailbox gmail outlook imap", label: "Connect a mailbox", run: go("/settings/mailboxes") },
          { value: "switch theme dark light", label: dark ? "Switch to the light theme" : "Switch to the dark theme", run: toggleTheme },
          { value: "show keyboard shortcuts help", label: "Show keyboard shortcuts", keys: "?", run: onShowShortcuts },
        ],
      },
    ].filter((group) => group.items.length);
  }, [query, search.data, recent.data, dark, toggleTheme, onShowShortcuts]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <CommandDialogPopup className="data-ending-style:duration-0 data-starting-style:duration-0">
        <Command items={groups} onValueChange={(value: string) => setQuery(value)} filter={(item: unknown, text: string) => matches(item, text)}>
          <CommandInput placeholder="Search conversations, or type a command" />
          <CommandPanel>
            <CommandEmpty>Nothing matches. Try a customer name, an email address or a word from the message.</CommandEmpty>
            <CommandList>
              {(group: Group) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: Item) => (
                        <CommandItem
                          key={item.value}
                          value={item}
                          onClick={() => {
                            onOpenChange(false);
                            setQuery("");
                            item.run();
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {item.hint ? <span className="truncate text-muted-foreground text-xs">{item.hint}</span> : null}
                          {item.keys ? <CommandShortcut>{keyLabel(item.keys).join(" ")}</CommandShortcut> : null}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-2">
                <KbdGroup>
                  <Kbd>
                    <ArrowUpIcon />
                  </Kbd>
                  <Kbd>
                    <ArrowDownIcon />
                  </Kbd>
                </KbdGroup>
                Move
              </span>
              <span className="flex items-center gap-2">
                <Kbd>
                  <CornerDownLeftIcon />
                </Kbd>
                Open
              </span>
            </div>
            <span className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              Close
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
