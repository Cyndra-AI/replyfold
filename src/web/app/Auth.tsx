import { useState } from "react";
import { api, type SessionResponse } from "../lib/api";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Wordmark } from "./Logo";

function Frame({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8 text-base" />
        <h1 className="font-medium text-lg tracking-[-0.01em]">{title}</h1>
        <p className="mt-1 mb-6 text-muted-foreground text-sm">{description}</p>
        {children}
        <p className="mt-10 text-muted-foreground text-xs">
          Replyfold is open source, built by{" "}
          <a href="https://cyndra.ai" target="_blank" rel="noreferrer" className="underline underline-offset-3 hover:text-foreground">
            Cyndra
          </a>
          .
        </p>
      </div>
    </main>
  );
}

export function AuthScreen({ session, onSignedIn }: { session: SessionResponse; onSignedIn: () => void }) {
  const setup = session.setupRequired;
  const [name, setName] = useState("");
  const [email, setEmail] = useState(session.demo?.email ?? "");
  const [password, setPassword] = useState(session.demo?.password ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(setup ? "/api/setup" : "/api/login", { method: "POST", body: setup ? { name, email, password } : { email, password } });
      onSignedIn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame
      title={setup ? "Create the owner account" : "Sign in"}
      description={setup ? "You are the first person here. This account can connect mailboxes and invite the team." : "Use the email and password your workspace owner gave you."}
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {session.demo ? (
          <Alert variant="info">
            <AlertDescription>Demo mode. The sign-in below is filled in, and the mailbox holds made-up mail.</AlertDescription>
          </Alert>
        ) : null}
        {setup ? (
          <Field>
            <FieldLabel>Your name</FieldLabel>
            <Input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Morgan Avery" />
          </Field>
        ) : null}
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input autoComplete="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" />
        </Field>
        <Field>
          <FieldLabel>Password</FieldLabel>
          <Input
            autoComplete={setup ? "new-password" : "current-password"}
            type="password"
            required
            minLength={setup ? 10 : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
        <Button type="submit" loading={busy} className="mt-1">
          {setup ? "Create account" : "Sign in"}
        </Button>
      </form>
    </Frame>
  );
}
