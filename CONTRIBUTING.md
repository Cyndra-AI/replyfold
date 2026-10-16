# Contributing to Replyfold

Thank you for helping. This page covers how to set up the project, what a good pull request looks like, and the few rules that keep Replyfold safe to run.

## Set up

1. Install [Bun](https://bun.sh) 1.4 or later.
2. Run `bun install`.
3. Run `bun run demo` and open http://localhost:3000.

The demo needs no mailbox and no model key. Use it for all UI work.

## Before you open a pull request

1. Run `bun run check`. It runs the type check and every test.
2. Add or change a test for each behavior you add or change. Tests live in `test/` and mirror `src/`.
3. Test through the public function or the HTTP API. A test that reads source text or mocks the store is not accepted.
4. For UI changes, add a screenshot of the demo to the pull request, in light and dark mode.
5. Keep one change per pull request.

## Rules that do not bend

- Replyfold never sends mail without a person pressing **Send**. Do not add auto-send, scheduled sends or bulk replies.
- Every external write goes through `deliver` in `src/drafts/send.ts`, so a retry never sends twice.
- Credentials stay encrypted with `SecretBox`. The API never returns a token, password or secret, and logs never contain one.
- Screenshots, fixtures and tests use made-up data and reserved domains (`example.com`, `example.org`, `example.net`, `*.example`). Never commit real customer mail.

## Add a mail provider

A provider implements `MailProvider` in `src/mail/provider.ts`: `pull(cursor)` returns new messages and the next cursor, and `send(mail)` sends one message or throws. Throw `SendRejectedError` when the provider refused the message, so the send is marked failed rather than uncertain. Then add it to `Runtime.providerFor` in `src/runtime.ts` and add tests with a fake transport, as `test/mail/imap.test.ts` does.

## Update the UI components

The components in `src/web/ui` come from the [coss ui](https://coss.com/ui) registry. Run `bun run sync:coss` to refresh them. Do not edit those files by hand. Wrap them in `src/web/app` instead.

## Style

TypeScript strict mode, no `any`, no `as` casts on external data. Parse input at the edge with `zod`. Comments explain why, not what.
