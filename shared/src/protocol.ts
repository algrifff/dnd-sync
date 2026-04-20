// Zod schemas for every message that crosses the server/plugin boundary.
// Import these in both packages so protocol drift is a compile error.

import { z } from 'zod';

// ── Auth ─────────────────────────────────────────────────────────────────────

export const AuthTokenSchema = z.object({
  scheme: z.literal('Bearer'),
  token: z.string().min(8),
});
export type AuthToken = z.infer<typeof AuthTokenSchema>;

// ── Search ───────────────────────────────────────────────────────────────────

export const SearchResultSchema = z.object({
  path: z.string(),
  snippet: z.string(),
  score: z.number().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(SearchResultSchema),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ── Files ────────────────────────────────────────────────────────────────────

export const FileMetadataSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
  updatedBy: z.string().optional(),
});
export type FileMetadata = z.infer<typeof FileMetadataSchema>;

// ── Web-app auth (phase 1) ───────────────────────────────────────────────────

export const UserRoleSchema = z.enum(['admin', 'editor', 'viewer']);
export type UserRole = z.infer<typeof UserRoleSchema>;

/** 3–32 chars, letters/digits/hyphen/underscore. Case-insensitive; stored
 *  COLLATE NOCASE in SQLite. */
export const UsernameSchema = z
  .string()
  .regex(/^[a-z0-9_-]{3,32}$/i, 'usernames are 3–32 chars of letters, digits, _ or -');

export const PasswordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(256, 'password too long');

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().min(1).max(64),
  password: PasswordSchema,
  role: UserRoleSchema,
  email: z.string().email().max(256).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

// ── Plugin sync API ──────────────────────────────────────────────────────

export const InventoryTextDocSchema = z.object({
  path: z.string(),
  updatedAt: z.number().int(),
  bytes: z.number().int().nonnegative(),
});

export const InventoryBinaryFileSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
  contentHash: z.string(),
});

export const InventoryResponseSchema = z.object({
  textDocs: z.array(InventoryTextDocSchema),
  binaryFiles: z.array(InventoryBinaryFileSchema),
});
export type InventoryResponse = z.infer<typeof InventoryResponseSchema>;

export const PluginVersionSchema = z.object({
  hash: z.string(),
});
export type PluginVersion = z.infer<typeof PluginVersionSchema>;

// ── Chat (Phase 3) ───────────────────────────────────────────────────────────

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.number().int(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  sessionId: z.string().uuid().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
