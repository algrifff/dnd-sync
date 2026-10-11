# Wrap-up runs on close, as reviewed, add-only proposals

Compendium's core loop is the table writing one shared Session log together, which then grows the World's collective brain. We decided that turning a log into knowledge (the **Wrap-up**) happens when a Session is closed, and works as follows:

- It produces a list of proposed changes that a person reviews before anything is written.
- It never applies changes live or directly.
- It only adds dated History entries to Notes and never rewrites existing text.
- Changes to a Character are held as Suggestions for that Character's own Player.

AI mistakes such as duplicate People, misattributed facts or overwritten prose would pollute knowledge the whole table relies on. A review step at a natural break in play catches them cheaply. A log that is still being edited can be wrapped up again safely, so we gain little by linking live as people type.

## Considered Options

- **Live linking while typing**: rejected for now. It needs AI calls on every edit against a CRDT document that several people are writing at once, and it gives no moment to review. It may be revisited as an assist layered on top of Wrap-up, not as a replacement for it.
- **Direct writes with no review** (the original behaviour): rejected. Errors land silently in shared Notes, and re-running creates duplicates.
- **Letting Wrap-up rewrite Notes to reflect new facts**: rejected. It silently overwrites what people wrote and loses the record of when the table learned what. Correcting older text stays a human job.

## Who may apply

Any Player who can see the Session may submit, review and apply its Wrap-up, not only the GM. This follows from Players running Sessions: whoever closes the table's log has the context to check the proposal, and the proposal is add-only, reviewed and cannot touch what the applier cannot see (hidden Notes read as missing, and a created Note is as hidden as its Session). We chose this over a GM-only gate because that gate would leave a Session unwrapped whenever the GM is absent. A stale review cannot overwrite a newer proposal: apply must echo the proposal's `generatedAt` and is refused with `proposal_changed` otherwise.

## Who a Suggestion is for

A Suggestion is addressed to the Character's Player at the moment the Wrap-up is applied (`owner_user_id`). It is not re-addressed if the Character is later reassigned to another Player: it then reads as not found to the old Player (the Character is no longer theirs) and is never shown to the new one. It stays held but unreachable, and re-applying the Wrap-up does not replace it, since there is one Suggestion per (Session, Character).

`/me` lists the current World's Suggestions only. A Player who belongs to several Worlds sees each World's Suggestions after switching to it.

Accepting is all or nothing: the Sheet with the new items is validated before any write, so a Sheet that does not validate leaves the Character, including its History, untouched.
