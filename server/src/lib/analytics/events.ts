// Canonical event names for PostHog. Keep snake_case, keep greppable,
// and keep prefixes stable — PostHog dashboards are built on top of
// these strings and renaming silently breaks funnels.

export const EVENTS = {
  // ── Auth / funnel ─────────────────────────────────────────────
  AUTH_LOGIN_SUCCESS: 'auth_login_success',
  AUTH_LOGIN_FAILED: 'auth_login_failed',
  AUTH_LOGOUT: 'auth_logout',
  WORLD_SELECTED: 'world_selected',

  // ── Note lifecycle ────────────────────────────────────────────
  NOTE_CREATED: 'note_created',
  NOTE_EDITED: 'note_edited',

  // ── AI chat ───────────────────────────────────────────────────
  CHAT_MESSAGE_SENT: 'chat_message_sent',
  CHAT_TOOL_CALLED: 'chat_tool_called',

  // ── Import pipeline ───────────────────────────────────────────
  IMPORT_UPLOADED: 'import_uploaded',
  IMPORT_PARSED: 'import_parsed',
  IMPORT_ANALYSED: 'import_analysed',
  IMPORT_REVIEW_VIEWED: 'import_review_viewed',
  IMPORT_APPLIED: 'import_applied',
  IMPORT_FAILED: 'import_failed',

  // ── Multiplayer ───────────────────────────────────────────────
  COLLAB_CONNECTED: 'collab_connected',
  COLLAB_DISCONNECTED: 'collab_disconnected',
  COLLAB_AUTH_REJECTED: 'collab_auth_rejected',
  COLLAB_READONLY: 'collab_readonly',
  DRAW_STROKE_STARTED: 'draw_stroke_started',
  DRAW_STROKE_COMMITTED: 'draw_stroke_committed',
  DRAW_SESSION_CO_USED: 'draw_session_co_used',
  PEER_PRESENCE_SEEN: 'peer_presence_seen',

  // ── Session workflow ──────────────────────────────────────────
  END_SESSION_CLICKED: 'end_session_clicked',
  END_SESSION_CONFIRMED: 'end_session_confirmed',
  END_SESSION_FAILED: 'end_session_failed',
  SESSION_CLOSED: 'session_closed',

  // ── Folder hygiene ────────────────────────────────────────────
  FOLDER_CREATED: 'folder_created',
  FOLDER_CREATE_REJECTED: 'folder_create_rejected',

  // ── Health & errors ───────────────────────────────────────────
  API_ERROR: 'api_error',
  CLIENT_ERROR: 'client_error',
  SERVER_BOOT: 'server_boot',
  SERVER_HEARTBEAT: 'server_heartbeat',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
