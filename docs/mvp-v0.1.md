# Obsidian RLM MVP v0.1

## Goal

Ship the first usable Obsidian-native RLM plugin: ask a question, let the LLM inspect relevant vault content through constrained tools, and return an answer with source note references.

## MVP Commands

| Command | Context | Result |
| --- | --- | --- |
| Ask RLM about current note | Active markdown file | Answer grounded in the active note and linked notes when useful. |
| Ask RLM about selection | Current editor selection | Answer grounded first in selected text, with optional note reads for context. |
| Ask RLM about folder | User-selected folder | Answer grounded in notes discovered inside that folder. |
| Ask RLM about vault | Whole vault | Answer grounded in search-driven note reads across the vault. |

## First Provider Decision

Start with LM Studio through its OpenAI-compatible chat completions and tool calls.

Default settings:

- base URL: `http://localhost:1234/v1`
- API key: optional
- model: user-configured

This keeps the first implementation narrow while leaving room for:

- Anthropic
- other local OpenAI-compatible servers
- Ollama-compatible adapters
- separate cheaper recursive or exploration models

## Tech Stack Decision

Use TypeScript with the Obsidian Plugin API and esbuild, matching the standard Obsidian plugin template.

Do not use a frontend framework for v0.1. Commands, settings, modals, and the result side panel should use native Obsidian plugin APIs.

## Plugin Identity Decision

- plugin ID: `rlm`
- display name: `RLM`
- package/repository name: `obsidian-rlm`
- desktop-only for v0.1

The plugin is desktop-only because LM Studio is expected to run as a local API server.

## First UI Decision

Use a question modal plus a result side panel, with an explicit option to insert the final answer into a new note.

The modal keeps command entry fast. The side panel gives enough room for:

- final answer
- source note links
- tool budget status
- errors
- cancellation state

Do not insert generated answers into the active note by default in v0.1.

The side panel should include an action that creates a new note containing:

- the question
- the answer
- source note links
- budget status if the request stopped early

Generated answer notes should be created under `RLM Answers/` with timestamped filenames.

## Required Tool Behavior

The MVP tool layer should include:

- `read_note(path)`
- `search_vault(query)`
- `list_folder(path)`
- `get_outgoing_links(path)`
- `get_backlinks(path)`

Each tool should return bounded, structured results. Tool output should include note paths where applicable so source tracking is straightforward.

## MVP Limits

Default limits:

- max tool calls: 20
- max notes read: 10
- max search results per query: 20
- max folder notes listed: 100
- max elapsed time: 60 seconds

The UI should clearly show when a request stopped because it hit a limit.

## Citation Decision

Use note-level citations for v0.1, such as:

```md
[[Projects/RLM Notes]]
```

Line-level and block-level citations are out of scope for v0.1.

## v0.1 Non-Goals

- Faithful Python package port
- Python REPL or arbitrary code execution
- Automatic background vault indexing
- Multi-agent workflows
- Automatic active-note edits
- Fine-grained line or block citations
- Provider marketplace
- Long-running background research jobs
- Cross-vault search
- Sync or cloud storage features

## Acceptance Criteria

v0.1 planning is complete when:

- `docs/architecture-v0.1.md` exists.
- This MVP command list is accepted.
- v0.1 non-goals are documented.
- A follow-up implementation issue can be opened for the Obsidian plugin scaffold.

## Implementation Sequence

1. Scaffold the Obsidian plugin with TypeScript.
2. Add settings for provider, model, API key, and budgets.
3. Implement the result side panel.
4. Implement the question modal.
5. Register MVP commands.
6. Implement vault tools with hard limits.
7. Implement the LLM tool loop.
8. Render final answers with source note links.
9. Add basic manual test notes and command walkthroughs.
