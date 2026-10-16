import { CheckIcon, HistoryIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type PlaybookResponse } from "../lib/api";
import { fullTime } from "../lib/format";
import { useShortcuts } from "../lib/keys";
import { invalidate, useResource } from "../lib/resource";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { useSession } from "./App";
import { Hotkey, PageHeader } from "./common";

export function Playbook() {
  const { user } = useSession();
  const playbook = useResource<PlaybookResponse>("/api/playbook");
  const current = playbook.data?.current?.content ?? "";
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canEdit = user.role !== "agent";
  const value = text ?? current;
  const dirty = text !== null && text !== current;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (!dirty || !canEdit) return;
    setSaving(true);
    try {
      await api("/api/playbook", { method: "PUT", body: { content: value, note: "Edited" } });
      setText(null);
      invalidate("/api/playbook");
      toastManager.add({ title: "Playbook saved", description: "New drafts use this version.", type: "success" });
    } finally {
      setSaving(false);
    }
  }

  async function decide(id: string, accept: boolean) {
    await api(`/api/suggestions/${id}/${accept ? "accept" : "reject"}`, { method: "POST", body: {} });
    setText(null);
    invalidate("/api/playbook");
  }

  async function restore(id: string) {
    await api(`/api/playbook/versions/${id}/restore`, { method: "POST", body: {} });
    setText(null);
    invalidate("/api/playbook");
    toastManager.add({ title: "Version restored", type: "success" });
  }

  useShortcuts([{ keys: "mod+s", label: "Save", group: "Playbook", run: () => void save(), allowInInput: true }]);

  const suggestions = playbook.data?.suggestions ?? [];
  const versions = playbook.data?.versions ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Playbook" description="Your rules and tone. Every draft follows it.">
        {canEdit && versions.length > 1 ? (
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="sm" />}>
              <HistoryIcon />
              {versions.length} versions
            </MenuTrigger>
            <MenuPopup align="end" className="w-72">
              {versions.slice(1, 12).map((version) => (
                <MenuItem key={version.id} onClick={() => void restore(version.id)}>
                  <span className="flex-1 truncate">{version.note || "Saved"}</span>
                  <span className="text-muted-foreground text-xs">{fullTime(version.savedAt)}</span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        {canEdit ? (
          <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={saving}>
            Save
            <Hotkey keys="mod+s" className="opacity-80 [&_kbd]:border-white/20 [&_kbd]:bg-white/12 [&_kbd]:text-primary-foreground" />
          </Button>
        ) : null}
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <textarea
            value={value}
            onChange={(event) => setText(event.target.value)}
            readOnly={!canEdit}
            aria-label="Playbook"
            spellCheck
            className="field-sizing-content block min-h-full w-full max-w-[80ch] resize-none bg-transparent px-8 py-6 font-mono text-[0.84rem] leading-[1.7] outline-none"
          />
        </div>
        <aside className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l bg-canvas p-5 xl:flex">
          <section>
            <h2 className="font-medium text-sm">Learned from edits</h2>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
              When someone rewrites a draft before sending it, Replyfold proposes a rule. Nothing changes until a lead accepts it.
            </p>
          </section>
          {suggestions.length ? (
            suggestions.map((suggestion) => (
              <article key={suggestion.id} className="rounded-lg border bg-background p-3">
                <p className="text-sm leading-snug">{suggestion.rule}</p>
                <p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">{suggestion.rationale}</p>
                {canEdit ? (
                  <div className="mt-3 flex gap-1.5">
                    <Button size="xs" onClick={() => void decide(suggestion.id, true)}>
                      <CheckIcon />
                      Add to playbook
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => void decide(suggestion.id, false)}>
                      <XIcon />
                      Dismiss
                    </Button>
                  </div>
                ) : null}
              </article>
            ))
          ) : (
            <p className="text-muted-foreground text-xs">No suggestions right now.</p>
          )}
          {!canEdit ? <p className="text-muted-foreground text-xs">Only owners and leads can edit the playbook.</p> : null}
        </aside>
      </div>
    </div>
  );
}
