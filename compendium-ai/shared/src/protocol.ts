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
