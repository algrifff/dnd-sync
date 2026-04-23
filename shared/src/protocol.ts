// Shared Zod schemas used across the server.

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

export const SignupRequestSchema = z.object({
  username: UsernameSchema,
  email: z.string().email().max(256),
  password: PasswordSchema,
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const PasswordResetRequestSchema = z.object({
  email: z.string().email().max(256),
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetConsumeSchema = z.object({
  token: z.string().length(64).regex(/^[a-f0-9]+$/),
  newPassword: PasswordSchema,
});
export type PasswordResetConsume = z.infer<typeof PasswordResetConsumeSchema>;

export const EmailVerifyConsumeSchema = z.object({
  token: z.string().length(64).regex(/^[a-f0-9]+$/),
});
export type EmailVerifyConsume = z.infer<typeof EmailVerifyConsumeSchema>;

// ── Chat ─────────────────────────────────────────────────────────────────────

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
