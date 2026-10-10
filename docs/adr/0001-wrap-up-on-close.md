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
