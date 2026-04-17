# Compendium AI — future plan

A custom Obsidian plugin that adds an AI chat assistant scoped to the vault. The assistant can search, organise, and link notes the same way this Claude Code session does, but **every read/write is through Obsidian's `app.vault` API — which is sandboxed to the vault by design, so it physically cannot touch anything outside The Compendium.**

## Why we think it's worth building

- DM prep is mostly "find the thing I wrote about X and connect it to Y"
- Obsidian has no native agentic AI; third-party plugins either cost money or have weak tool-use
- Tight coupling to our vault structure (Campaign 3 / NPCs / Sessions / …) means a purpose-built assistant outperforms a generic one

## Architecture (TypeScript Obsidian plugin)

```
┌──────────────────────────────────┐
│  Chat pane (right sidebar view)  │
│  ─ messages, input, settings     │
└──────────────┬───────────────────┘
               │
          agentic loop
               │
    ┌──────────┴──────────┐
    │   Provider adapter  │  ← Claude / Ollama / OpenAI-compatible
    └──────────┬──────────┘
               │ tool calls
               ▼
    ┌─────────────────────────────────────────┐
    │  Vault tools (thin app.vault wrappers)  │
    │  - search_notes(query)                  │
    │  - read_note(path)                      │
    │  - write_note(path, content)            │
    │  - append_note(path, content)           │
    │  - list_notes(folder)                   │
    │  - link_notes(from, to)  (optional)     │
    └─────────────────────────────────────────┘
```

Everything in the tool layer is a wrapper over `this.app.vault.*` / `this.app.metadataCache.*`, so the LLM cannot reach beyond the vault even if it tried.

## Phased plan

### Phase 1 — Cloud-first MVP (~1 weekend)
- Scaffold from `obsidian-sample-plugin`
- Chat pane with message history, markdown rendering
- Agentic loop against Anthropic API (Claude Haiku — pennies per session)
- 5 tools above
- Settings: paste API key, pick model
- Bundle the plugin into `scripts/setup-livesync-*.sh` — drop files into `.obsidian/plugins/compendium-ai/`, pre-populate `data.json`

### Phase 2 — Add local AI (~another weekend)
- Bundle [Ollama](https://ollama.com) installer
- Pre-pull a tool-use-capable model (`qwen2.5:7b` or `llama3.1:8b`, ~5GB)
- Plugin "provider" dropdown: Claude / Ollama
- Tool surface stays identical — only the LLM backend changes

## Key decisions still open

1. **Cloud provider:** Anthropic only, or OpenAI-compatible interface so the same adapter works with Ollama later? (Marginally more work now, avoids a refactor.)
2. **Tool scope:** just the 5 above, or domain-specific ones — "summarise this session", "find all alive NPCs in a location", dataview queries?
3. **Auth model:** each user brings their own Claude API key (cheaper, no shared secret), or a shared proxy with one key the DM pays for (friendlier UX, you eat the cost)?

## The main tradeoff

Local AI is free and private but ~5GB download, needs 8GB+ RAM for a usable model, and tool-use quality is meaningfully worse than Claude on this kind of "reason about linked notes" task. Cloud is pennies per session but needs API keys.

Recommended start: **cloud-only MVP**. Add Ollama later as an optional toggle once the plugin has proven its shape.

## When we come back to this

Create a branch `compendium-ai`, scaffold the plugin, answer the three open questions above, then follow Phase 1. Don't start before this branch (`livesync-couchdb`) is merged — we don't want the AI plugin bundled into a sync backend we might throw away.
