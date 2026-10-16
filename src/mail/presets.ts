export type ImapPreset = {
  id: string;
  label: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  passwordHelp: string;
};

/** Server settings for common IMAP providers. Each one needs an app password, not the account password. */
export const IMAP_PRESETS: ImapPreset[] = [
  {
    id: "yahoo",
    label: "Yahoo Mail",
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    passwordHelp: "Create an app password under Account security in Yahoo.",
  },
  {
    id: "icloud",
    label: "iCloud Mail",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    passwordHelp: "Create an app-specific password at account.apple.com.",
  },
  {
    id: "fastmail",
    label: "Fastmail",
    imap: { host: "imap.fastmail.com", port: 993, secure: true },
    smtp: { host: "smtp.fastmail.com", port: 465, secure: true },
    passwordHelp: "Create an app password with IMAP and SMTP access in Fastmail settings.",
  },
  {
    id: "zoho",
    label: "Zoho Mail",
    imap: { host: "imap.zoho.com", port: 993, secure: true },
    smtp: { host: "smtp.zoho.com", port: 465, secure: true },
    passwordHelp: "Turn on IMAP access and create an app password in Zoho Mail.",
  },
  {
    id: "aol",
    label: "AOL Mail",
    imap: { host: "imap.aol.com", port: 993, secure: true },
    smtp: { host: "smtp.aol.com", port: 465, secure: true },
    passwordHelp: "Create an app password under Account security in AOL.",
  },
  {
    id: "gmx",
    label: "GMX",
    imap: { host: "imap.gmx.com", port: 993, secure: true },
    smtp: { host: "mail.gmx.com", port: 587, secure: false },
    passwordHelp: "Turn on IMAP access in GMX settings.",
  },
];
