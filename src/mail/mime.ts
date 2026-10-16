import type { Address } from "../core/types";

const CRLF = "\r\n";

function splitTopLevel(value: string) {
  const parts: string[] = [];
  let quoted = false;
  let angled = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) angled = true;
    else if (char === ">" && !quoted) angled = false;
    else if (char === "," && !quoted && !angled) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function parseAddress(value: string): Address {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(value);
  if (match) return { name: (match[1] ?? "").trim(), email: match[2]!.trim().toLowerCase() };
  return { name: "", email: value.trim().toLowerCase() };
}

export function parseAddressList(value: string): Address[] {
  return splitTopLevel(value).map(parseAddress);
}

export function replySubject(subject: string) {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: your message";
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function headerSafe(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function encodeHeader(value: string) {
  const safe = headerSafe(value);
  return /^[\x20-\x7e]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

export function formatAddress(address: Address) {
  const email = headerSafe(address.email).split(/\s/)[0] ?? "";
  const name = headerSafe(address.name);
  if (!name) return email;
  const display = /^[\w .'-]+$/.test(name) ? name : `"${name.replace(/"/g, "'")}"`;
  return `${encodeHeader(display)} <${email}>`;
}

function base64Lines(data: string) {
  return (data.match(/.{1,76}/g) ?? []).join(CRLF);
}

export type MimeInput = {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html: string;
  messageIdHeader: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
  boundary?: string;
};

/** RFC 5322 text with base64 parts, so the output is pure ASCII in any language. */
export function buildMime(input: MimeInput): string {
  const boundary = input.boundary ?? `rf_${crypto.randomUUID().replaceAll("-", "")}`;
  const list = (addresses: Address[]) => addresses.map(formatAddress).join(", ");
  const headers = [
    `From: ${formatAddress(input.from)}`,
    `To: ${list(input.to)}`,
    ...(input.cc.length ? [`Cc: ${list(input.cc)}`] : []),
    ...(input.bcc.length ? [`Bcc: ${list(input.bcc)}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${headerSafe(input.messageIdHeader)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${headerSafe(input.inReplyTo)}`] : []),
    ...(input.references?.length ? [`References: ${input.references.map(headerSafe).join(" ")}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) => [
    `--${boundary}`,
    `Content-Type: ${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(body, "utf8").toString("base64")),
  ];
  return [...headers, "", ...part("text/plain", input.text), ...part("text/html", input.html), `--${boundary}--`, ""].join(CRLF);
}

export function newMessageId(domainOf: string) {
  const domain = domainOf.split("@")[1] || "replyfold.local";
  return `<${crypto.randomUUID()}@${domain}>`;
}
