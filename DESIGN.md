# Design

Operate mode. Linear-style working surface built with coss ui (Base UI) components.

## Principles

- Dense and calm. The inbox shows many rows without noise.
- Keyboard first. Every frequent action has a key, shown next to its button.
- One accent. Pine green marks the primary action, the current selection and unread state. Nothing else is colored.
- Hairline structure. 1px alpha borders separate panes. Shadows only on floating layers (menus, dialogs, toasts).
- No animation on keyboard actions. Popovers and dialogs use 150 to 200 ms ease-out from Base UI's transform origin.

## Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` | #1F5F4E | #8CC2AE | Primary button, focus ring, selection, unread dot |
| `--background` | #FFFFFF | #121413 | Reading pane |
| `--canvas` | #FBFBFA | #101211 | List pane |
| `--sidebar` | #F6F6F4 | #0D0F0E | Sidebar |
| coss neutrals | from `src/web/coss-theme.css` | | Text, borders, muted text |
| coss warning, destructive, info, success | | | Draft checks, send state |

## Type

Geist Sans for all UI text, Geist Mono for keys and ids only. Root size 15px, so rem steps are compact.

| Step | Size | Use |
|---|---|---|
| Avatar initials | 0.5rem, 0.6rem, 0.7rem | Initials inside 16, 20 and 28px avatars |
| xs | 0.75rem | Meta, counts, timestamps |
| sm | 0.875rem | Body, list rows, controls |
| base | 0.95rem | Page and pane titles |
| lg | 1.125rem | Conversation subject |
| 2xl | 1.5rem | Statistics figures |

## Layout

Three panes: sidebar 232px, list 400px, reader fills the rest. Under 1024px the
list and reader share one column. Rows are 2 lines, 64px tall.
