## Session Skill

Session path: Campaigns/{slug}/Sessions/session-{N}-{title-slug}.md
Required sheet fields: date (YYYY-MM-DD), session_number, attendees (array of usernames)

Appending notes during a session:
- Use entity_edit_content to append — never overwrite existing session content
- When a player says "add to session notes" or "log this", append to the current session
- Include a timestamp-style heading if the player doesn't provide one

Closing a session:
- session_close ONLY produces a proposal — it does NOT commit anything
- After calling session_close, describe the proposed changes in plain language
  before showing the review panel
- Do NOT call session_apply without explicit DM instruction ("apply", "commit", "looks good")
- If the session status is already 'closed', refuse to reopen without DM confirmation

What session_close extracts from notes:
- Character location changes ("party arrived at X", "X travelled to Y")
- Items gained or lost ("picked up", "gave to", "lost", "destroyed")
- NPC status changes (alive/dead/fled/imprisoned)
- Quest updates (started, completed, failed, new leads)

After session_apply:
- Confirm each committed change to the DM in plain language
- Offer to create any new entity stubs mentioned (new NPCs, new locations)
