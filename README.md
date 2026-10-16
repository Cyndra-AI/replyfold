<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="Replyfold" width="240">
</picture>

# Replyfold

Built by [Cyndra](https://cyndra.ai).

![Every reply drafted. Nothing sent without you. Open-source support inbox for Gmail, Outlook and any IMAP mailbox.](assets/hero.png)

Replyfold is a support inbox you run on your own server. It connects your team's shared mailbox, writes a draft reply for every new customer email from your playbook, and sends only what a person approves.

- It connects Gmail and Google Workspace, Microsoft 365 and Outlook.com, or any mailbox with IMAP and SMTP (Yahoo, iCloud, Fastmail, Zoho, AOL, GMX, your own domain).
- It uses your credentials and your model. Drafts come from the Codex CLI signed in with your ChatGPT account, or from any OpenAI-compatible API.
- It stores everything in one SQLite file. Mailbox credentials are encrypted with a key only your server has.
- It sends nothing on its own. Every reply goes out when someone presses **Send**.

Status: early. Expect breaking changes before 1.0.

![The inbox with an AI draft ready to send](docs/screenshots/inbox.png)

## How it works

![Your mailbox feeds Replyfold on your server. An analyst reads the thread, a writer drafts from your playbook, and checks flag problems. You review and send. Rewrites become playbook suggestions.](assets/how-it-works.png)

1. Replyfold checks each connected mailbox every minute.
2. For each new customer email, the model makes two calls. The analyst call reads the whole thread and lists the facts it relies on. The writer call drafts the reply from your playbook.
3. The server checks every draft. It flags links that are not in the thread or the playbook, unfilled placeholders, raw timestamps, internal wording, missing information, and cases that need a person's judgment.
4. You read the draft next to the thread, edit it, and send it with Ctrl+Enter (Cmd+Enter on a Mac). The reply goes out from your mailbox, in the same thread.
5. When someone rewrites a draft before sending it, Replyfold proposes a playbook rule. A lead accepts or dismisses it. Nothing changes the playbook on its own.

Sends are safe to retry. Each send has a key, so a double click sends once. If the mail server stops answering after the message left, the conversation shows "This reply may already have been sent" until someone checks the Sent folder.

## Try the demo

The demo uses a made-up shop, made-up customers and a built-in model. It needs no mailbox, no API key and no Codex sign-in.

```bash
git clone https://github.com/Cyndra-AI/replyfold.git
cd replyfold
bun install
bun run demo
```

Open http://localhost:3000. The sign-in form is already filled in. The demo keeps its data in memory, so a restart resets it.

## Run it for your team

You need [Bun](https://bun.sh) 1.4 or later.

1. Copy the example settings: `cp .env.example .env`
2. Set `REPLYFOLD_SECRET_KEY` to a random string. `openssl rand -base64 32` makes one. Keep it safe: without it, Replyfold cannot read the stored mailbox credentials.
3. Pick a model. For the Codex CLI, run `codex login` once on the server. For an OpenAI-compatible API, set `MODEL_PROVIDER=openai`, `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL`.
4. Set `PUBLIC_URL` to the address your team opens, for example `https://support.yourshop.com`.
5. Start the server: `bun run start`
6. Open the app and create the owner account.
7. Go to **Settings**, then **Mailboxes**, and connect your mailbox.

### Connect Gmail or Google Workspace

1. In your Google Cloud project, turn on the Gmail API.
2. Create an OAuth client of type **Web application**.
3. Add `PUBLIC_URL/api/oauth/gmail/callback` as an authorized redirect URI.
4. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Restart Replyfold and click **Connect** next to Gmail.

Replyfold asks for the `gmail.modify` scope, which lets it read and send mail.

### Connect Microsoft 365 or Outlook.com

1. In Microsoft Entra, register an app. Allow work and personal accounts if you want to connect an Outlook.com address.
2. Add `PUBLIC_URL/api/oauth/microsoft/callback` as a **Web** redirect URI.
3. Create a client secret.
4. Put the values in `.env` as `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. Set `MICROSOFT_TENANT` if you want to limit sign-in to one organization.
5. Restart Replyfold and click **Connect** next to Microsoft 365.

Replyfold asks for `Mail.ReadWrite`, `Mail.Send`, `User.Read` and `offline_access`.

### Connect any other mailbox

Pick your provider in the IMAP and SMTP form, or enter the server names for your own domain. Use an app password, not your account password. Replyfold signs in to both servers before it saves the mailbox.

On the first sync, Replyfold reads the last 14 days of mail.

## Screenshots

| | |
|---|---|
| ![A draft that needs review, with the analysis open](docs/screenshots/draft-review.png) | ![The inbox in dark mode](docs/screenshots/inbox-dark.png) |
| ![Reply volume, edit quality, topics and replies per person](docs/screenshots/insights.png) | ![The playbook editor with a learned suggestion](docs/screenshots/playbook.png) |
| ![Connecting Gmail, Microsoft 365 or an IMAP mailbox](docs/screenshots/mailboxes.png) | ![The command menu searching conversations](docs/screenshots/command-menu.png) |
| ![Writing a new email](docs/screenshots/compose.png) | ![The reader on a phone](docs/screenshots/phone.png) |

## Keyboard

| Key | Action |
|---|---|
| J, K | Next and previous conversation |
| Ctrl+Enter or Cmd+Enter | Send the reply |
| R | Edit the reply |
| Shift+R | Write the draft again with an instruction |
| E | Close the conversation |
| I | Assign it to me |
| / | Search the current view |
| C | Write a new email |
| Ctrl+K or Cmd+K | Open the command menu |
| G, then I, M, W, P, S | Go to Open, Mine, Waiting, Playbook or Insights |
| ? | Show every shortcut |

## Roles

| Role | Can |
|---|---|
| Agent | Read and answer conversations, assign them, set reminders |
| Lead | Also edit the playbook, accept suggestions, connect and pause mailboxes |
| Owner | Also add and remove teammates, change roles, disconnect mailboxes |

## Agents and MCP

Set `MCP_TOKEN` to turn on a read-only [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`. Send the token as `Authorization: Bearer <token>`. The tools are `list_conversations`, `get_conversation`, `get_statistics` and `get_playbook`. The endpoint cannot send mail or change anything.

## Develop

```bash
bun install
bun run demo        # demo workspace on port 3000
bun run check       # type check and tests
bun run sync:coss   # refresh the coss ui components in src/web/ui
```

The code is organized by job:

| Folder | Holds |
|---|---|
| `src/mail` | Mail providers (Gmail, Microsoft Graph, IMAP and SMTP), OAuth, MIME and the sync that files mail into conversations |
| `src/drafts` | The analyst and writer prompts, draft checks, sending, and learning from edits |
| `src/ai` | Model adapters for the Codex CLI and OpenAI-compatible APIs |
| `src/db` | The SQLite schema and store |
| `src/server` | The HTTP API and the MCP endpoint |
| `src/web` | The React app, built with [coss ui](https://coss.com/ui) components |
| `src/demo` | The made-up shop, mailbox and model for the demo |

See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE)

Built by [Cyndra](https://cyndra.ai).
