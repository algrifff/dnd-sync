// Canonical title format for session notes:
// "Session <N>_<DisplayName>_<YYYY-MM-DD>". The leading number makes the
// sidebar's title sort chronological. Used by /api/sessions/create.
export function generateSessionTitle(
  sessionNumber: number,
  displayName: string,
  date: string,
): string {
  const name = displayName.trim();
  return name
    ? `Session ${sessionNumber}_${name}_${date}`
    : `Session ${sessionNumber}_${date}`;
}
