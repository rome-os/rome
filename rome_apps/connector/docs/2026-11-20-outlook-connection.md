# Rome-managed Outlook

Outlook proxy calls prefer the Microsoft connection held by core, the same way
Gmail prefers the Google connection. Only absence, or a grant without
`Mail.Read`, falls back to Composio. A broken Microsoft grant does not switch
mailboxes. Only Graph mail paths go to core: calendar, contacts and the rest
of Graph stay on Composio's Outlook connection, as do its tools and events.
The Microsoft card is opt-in under `SHOW_MICROSOFT_OAUTH` until a live consent,
read and send are verified.

Rome Cloud brokers the connection through Rome's Microsoft app with
`offline_access`, `User.Read`, `Mail.Read` and `Mail.Send`. Sign-in with
Microsoft stays identity-only.

Core keeps the Microsoft credential inside its connection Actor, not a shared
token file. It allows only Graph GETs of the profile, messages and mail folders,
without attachments or MIME. Its separate send action requires guardian approval
for every exact message and uses the existing card, which shows From, To,
Subject and Body. The Actor checks that `/v1.0/me` still names the approved From
before it calls `sendMail`.

A send is always a new message. Graph's reply endpoints choose recipients from
the original message (`replyTo` or sender), and `createReply` needs
`Mail.ReadWrite`, so neither can promise that only the approved recipients
receive the mail. Threaded replies need live verification first.

Tests use fake credentials and provider replies. No real Microsoft consent or
mailbox is used.
