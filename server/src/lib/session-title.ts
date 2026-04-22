// Canonical title format for session notes: "<DisplayName> — <YYYY-MM-DD>".
// Used by the /api/sessions/create route and referenced in the AI session skill.
export function generateSessionTitle(displayName: string, date: string): string {
  const name = displayName.trim() || 'Session';
  return `${name} \u2014 ${date}`;
}
