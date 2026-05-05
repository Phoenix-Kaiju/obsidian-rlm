# RLM

RLM is an Obsidian plugin for asking questions against a vault through a constrained, Obsidian-native tool layer.

v0.1 targets LM Studio through its OpenAI-compatible API. The plugin is desktop-only while the default workflow depends on a local LM Studio server.

## Connect LM Studio

Use the plugin settings and point them at LM Studio's OpenAI-compatible server.

1. Start LM Studio.
2. Load the model you want to use.
3. Start the local server.
4. Confirm the server endpoint. The default LM Studio server URL is usually:

```text
http://localhost:1234/v1
```

5. In Obsidian, open `Settings -> Community plugins -> RLM`.
6. Set these fields:
   - `LM Studio base URL`: `http://localhost:1234/v1`
   - `API key`: leave blank unless your LM Studio server expects one
   - `Model`: enter the model identifier LM Studio expects for requests
7. Open a note and run an RLM command from the command palette, such as:
   - `RLM: Ask about current note`
   - or one of the other ask commands

Important details:

- The plugin does not discover the model automatically.
- The `Model` field must match what LM Studio exposes on its local API.
- If requests fail, the usual causes are:
  - LM Studio server is not running
  - no model is loaded
  - the configured model identifier is wrong
  - the base URL is missing `/v1`

## Development

```bash
npm install
npm run dev
```

Build the plugin:

```bash
npm run build
```

The Obsidian plugin artifacts are:

- `main.js`
- `manifest.json`
- `styles.css`

## MVP

See:

- `docs/architecture-v0.1.md`
- `docs/mvp-v0.1.md`

