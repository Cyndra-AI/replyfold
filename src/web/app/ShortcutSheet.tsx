import type { Shortcut } from "../lib/keys";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Hotkey } from "./common";

export const INBOX_SHORTCUTS: Array<Pick<Shortcut, "keys" | "label" | "group">> = [
  { keys: "j", label: "Next conversation", group: "Inbox" },
  { keys: "k", label: "Previous conversation", group: "Inbox" },
  { keys: "Enter", label: "Open the selected conversation", group: "Inbox" },
  { keys: "Escape", label: "Back to the list", group: "Inbox" },
  { keys: "/", label: "Search this view", group: "Inbox" },
  { keys: "r", label: "Edit the reply", group: "Conversation" },
  { keys: "mod+Enter", label: "Send the reply", group: "Conversation" },
  { keys: "e", label: "Close the conversation", group: "Conversation" },
  { keys: "i", label: "Assign to me", group: "Conversation" },
  { keys: "shift+R", label: "Write the draft again", group: "Conversation" },
];

export function ShortcutSheet({ open, onOpenChange, shortcuts }: { open: boolean; onOpenChange: (open: boolean) => void; shortcuts: Shortcut[] }) {
  const all = [...shortcuts, ...INBOX_SHORTCUTS];
  const groups = [...new Set(all.map((shortcut) => shortcut.group))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts work anywhere outside a text field. Press ? to open this list.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5 pb-6">
          {groups.map((group) => (
            <section key={group}>
              <h3 className="mb-1.5 font-medium text-muted-foreground text-xs">{group}</h3>
              <ul className="divide-y rounded-lg border">
                {all
                  .filter((shortcut) => shortcut.group === group)
                  .map((shortcut) => (
                    <li key={shortcut.keys} className="flex items-center justify-between px-3 py-1.5 text-sm">
                      {shortcut.label}
                      <Hotkey keys={shortcut.keys} />
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
