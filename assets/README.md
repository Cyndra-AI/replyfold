# Replyfold artwork

| File | Use |
| --- | --- |
| `logo-light.svg`, `logo-dark.svg` | Mark and wordmark. The README picks the variant for the reader's color scheme. |
| `mark-light.svg`, `mark-dark.svg` | The mark alone. The app favicon is `mark-light.svg`. |
| `logo-light.png`, `logo-dark.png` | Square raster logos, 1254 by 1254 pixels. |
| `hero.png` | README banner, 1774 by 887 pixels. |
| `how-it-works.png` | The mail, draft and send loop, 1774 by 887 pixels. |

The PNG artwork was generated with the image tool in the Codex CLI on the `gpt-6.1-sol` model. The SVG files are drawn by hand from the generated mark.

The logo prompt asked for a sheet of paper whose top-right corner folds down into a reply arrow, in pine green `#1F5F4E` and sage `#9CC5B4`, with a lowercase `replyfold` wordmark. The dark version keeps the geometry and swaps the colors for a dark background.

The banner and diagram prompts used the logo as a style reference. The banner holds the exact text "Every reply drafted.", "Nothing sent without you." and "Open-source support inbox for Gmail, Outlook and any IMAP mailbox". The diagram labels match the draft workflow in `src/drafts/workflow.ts`. Both prompts excluded real company logos and people.

The screenshots in `docs/screenshots` come from the running app in demo mode (`bun run demo`). Every name, address and message in them is made up. Desktop captures are 1440 by 900 pixels, the mailbox settings capture is 1440 by 1000, and the phone capture is 390 by 844. Each file is the original capture.
