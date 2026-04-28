# Obsidian RLM Architecture v0.1

## Goal

Obsidian RLM is an Obsidian-native plugin that answers questions against a user's vault by letting an LLM inspect notes through constrained vault-aware tools.

The first version should preserve the useful idea from Recursive Language Models: the model should not receive the whole context up front. Instead, it should decide which pieces of the vault to inspect, then produce an answer grounded in the notes it actually read.

## Product Shape

The plugin runs inside Obsidian and uses Obsidian APIs for vault access, metadata, links, backlinks, editor selection, commands, settings, and UI.

The plugin is not a direct port of the Python RLM package. It should not expose a Python REPL or arbitrary code execution. The recursive exploration layer becomes a tool-calling loop over Obsidian primitives.

## Tech Stack

v0.1 should use the standard Obsidian plugin stack:

- TypeScript
- Obsidian Plugin API
- npm scripts
- esbuild
- no frontend framework

The plugin should render UI with native Obsidian plugin APIs for commands, modals, settings, and side panels. React, Svelte, Vue, or another UI framework can be reconsidered later if the UI becomes complex enough to justify it.

The LM Studio integration should use direct HTTP requests to its OpenAI-compatible API.

## Plugin Identity

v0.1 plugin metadata:

- plugin ID: `rlm`
- display name: `RLM`
- package/repository name: `obsidian-rlm`
- desktop-only: yes

The plugin is desktop-only for v0.1 because the default LM Studio workflow depends on a local API server.

## Core Flow

1. The user starts an RLM command from Obsidian.
2. The plugin builds a task request from the current context:
   - current note
   - selected text
   - selected folder
   - whole vault
3. The LLM receives the user question, tool instructions, and budget limits.
4. The LLM explores the vault using constrained tools.
5. The plugin returns a final answer with source note references.

## Tool Layer

The v0.1 tool layer should expose a small set of deterministic Obsidian-native operations:

| Tool | Purpose |
| --- | --- |
| `read_note` | Read a note by path. |
| `search_vault` | Search note paths and note text for relevant matches. |
| `list_folder` | List markdown notes inside a folder. |
| `get_outgoing_links` | Return links from a note using Obsidian metadata. |
| `get_backlinks` | Return notes that link to a target note. |

Tools should return compact structured data, not full unbounded note dumps by default. Large note reads should support preview or bounded ranges if needed after v0.1.

## Agent Loop

The agent loop is responsible for:

- constructing the initial prompt
- exposing the tool schema
- executing approved tool calls
- tracking source notes used by the model
- enforcing budget limits
- asking for a final answer with citations

The loop should stop when any of these happens:

- the model returns a final answer
- max tool calls is reached
- max notes read is reached
- max elapsed time is reached
- the user cancels the request

## Source References

Every final answer should include source note references for claims drawn from the vault. v0.1 source references can be note-level links, such as:

```md
[[Projects/RLM Notes]]
```

Block-level or line-level citations are out of scope for v0.1 unless they fall out naturally from Obsidian APIs without extra indexing.

## Provider Layer

v0.1 should support one provider shape first and keep the provider boundary narrow enough to add others later.

First provider: LM Studio through its OpenAI-compatible API.

Default LM Studio settings:

- base URL: `http://localhost:1234/v1`
- API key: optional
- model: user-configured

The provider interface should cover:

- model name
- API key or compatible base URL settings
- chat completion request
- tool call request and response handling
- cancellation

LM Studio may expose multiple API-compatible surfaces over time, but v0.1 should only implement the OpenAI-compatible path. Anthropic-compatible requests and other providers can be added after the Obsidian command and tool loop is stable.

## UI

v0.1 should use a modal for short question entry and a side panel for results because answers and source references need persistent space.

Recommended first UI:

- command opens a question modal when needed
- answer streams or renders in a side panel
- source notes render as clickable Obsidian links
- errors and budget stops render in the same panel
- the user can optionally insert the final answer into a new note

Generated answers should not be inserted into the active note by default. v0.1 may offer an explicit action to create a new note containing the answer and source references.

Generated answer notes should be created under `RLM Answers/`. Filenames should combine a timestamp with a short question slug.

## Settings

Minimum settings for v0.1:

- provider
- model
- API key
- max tool calls
- max notes read
- max search results
- answer token limit

Settings should default to conservative limits.

## Safety And Cost Limits

The plugin must bound exploration so a whole-vault question cannot scan indefinitely or generate unexpected cost.

Initial defaults:

- max tool calls: 20
- max notes read: 10
- max search results per query: 20
- max folder notes listed: 100
- max elapsed time: 60 seconds

The UI should make budget stops visible instead of silently returning partial answers as complete.

## v0.1 Non-Goals

- Faithful Python package port
- Python REPL or arbitrary code execution
- Automatic background vault indexing
- Multi-agent workflows
- Automatic note mutation
- Fine-grained line or block citations
- Provider marketplace
- Long-running background research jobs
- Cross-vault search
- Sync or cloud storage features
