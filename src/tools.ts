import { App, TFile, TFolder } from "obsidian";
import { VaultContextReaders } from "./context";

export interface RlmToolExecutionSettings {
  app: App;
  maxNotesRead: number;
  maxSearchResults: number;
  maxFolderNotesListed: number;
  maxNoteCharacters: number;
  ignoredFolders: string[];
}

export interface RlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface RlmToolExecutionResult {
  output: unknown;
  sources: string[];
}

interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

type SummarizeCallback = (text: string, instruction: string, depth: number) => Promise<string>;

export class RlmToolExecutor {
  private readonly contextReaders: VaultContextReaders;

  constructor(
    private readonly settings: RlmToolExecutionSettings,
    private readonly summarizeCallback: SummarizeCallback,
  ) {
    this.contextReaders = new VaultContextReaders(settings.app, {
      maxNotesRead: settings.maxNotesRead,
      maxFolderNotesListed: settings.maxFolderNotesListed,
      maxNoteCharacters: settings.maxNoteCharacters,
      ignoredFolders: settings.ignoredFolders,
    });
  }

  getDefinitions(): RlmToolDefinition[] {
    return [
      {
        type: "function",
        function: {
          name: "readNote",
          description: "Read a Markdown note by vault-relative path.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative Markdown path." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "searchVault",
          description: "Search note paths and note contents for a query.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Case-insensitive search query." },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "listFolder",
          description: "List Markdown notes inside a folder.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative folder path." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getLinkedNotes",
          description: "Get notes linked from a given note path.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative Markdown path." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getBacklinks",
          description: "Get notes that link to a given note path.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Vault-relative Markdown path." },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "summarizeText",
          description: "Summarize or transform a block of text using a recursive LLM call.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to summarize or transform." },
              instruction: { type: "string", description: "Instruction for the summary." },
            },
            required: ["text", "instruction"],
            additionalProperties: false,
          },
        },
      },
    ];
  }

  async execute(toolCall: ToolCall, depth: number, maxDepth: number): Promise<RlmToolExecutionResult> {
    const args = this.parseArguments(toolCall.function.arguments);

    switch (toolCall.function.name) {
      case "readNote":
        return this.readNote(this.requireString(args, "path"));
      case "searchVault":
        return this.searchVault(this.requireString(args, "query"));
      case "listFolder":
        return this.listFolder(this.requireString(args, "path"));
      case "getLinkedNotes":
        return this.getLinkedNotes(this.requireString(args, "path"));
      case "getBacklinks":
        return this.getBacklinks(this.requireString(args, "path"));
      case "summarizeText":
        if (depth + 1 > maxDepth) {
          throw new Error(`Maximum tool depth (${maxDepth}) exceeded.`);
        }
        return this.summarizeText(
          this.requireString(args, "text"),
          this.requireString(args, "instruction"),
          depth + 1,
        );
      default:
        throw new Error(`Unsupported tool requested: ${toolCall.function.name}`);
    }
  }

  private async readNote(path: string): Promise<RlmToolExecutionResult> {
    const result = await this.contextReaders.readCurrentNote(path);
    return {
      output: result.records[0] ?? { path, error: "Note not found." },
      sources: result.records.map((record) => record.path),
    };
  }

  private async searchVault(query: string): Promise<RlmToolExecutionResult> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      throw new Error("searchVault requires a non-empty query.");
    }

    const matches: Array<{ path: string; title: string; preview: string }> = [];
    const files = this.settings.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.isIgnored(file.path));

    for (const file of files) {
      if (matches.length >= this.settings.maxSearchResults) {
        break;
      }

      const haystack = `${file.path}\n${await this.settings.app.vault.cachedRead(file)}`;
      const index = haystack.toLowerCase().indexOf(normalizedQuery);
      if (index < 0) {
        continue;
      }

      matches.push({
        path: file.path,
        title: file.basename,
        preview: this.createPreview(haystack, index, normalizedQuery.length),
      });
    }

    return {
      output: {
        query,
        matches,
        truncated: matches.length >= this.settings.maxSearchResults,
      },
      sources: matches.map((match) => match.path),
    };
  }

  private async listFolder(path: string): Promise<RlmToolExecutionResult> {
    const normalized = this.normalizePath(path);
    const folder = this.settings.app.vault.getAbstractFileByPath(normalized);
    if (!(folder instanceof TFolder)) {
      throw new Error(`Folder not found: ${path}`);
    }

    const notes = folder.children
      .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
      .filter((child) => !this.isIgnored(child.path))
      .sort((left, right) => left.path.localeCompare(right.path));

    const limited = notes.slice(0, this.settings.maxFolderNotesListed);
    return {
      output: {
        path: normalized,
        notes: limited.map((file) => ({ path: file.path, title: file.basename })),
        truncated: notes.length > limited.length,
      },
      sources: limited.map((file) => file.path),
    };
  }

  private async getLinkedNotes(path: string): Promise<RlmToolExecutionResult> {
    const file = this.getMarkdownFile(path);
    if (!file) {
      throw new Error(`Note not found: ${path}`);
    }

    const cache = this.settings.app.metadataCache.getFileCache(file);
    const links = [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])];
    const resolved = new Map<string, string>();

    for (const link of links) {
      const destination = this.settings.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
      if (destination && !this.isIgnored(destination.path)) {
        resolved.set(destination.path, destination.basename);
      }
    }

    const notes = Array.from(resolved.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([linkedPath, title]) => ({ path: linkedPath, title }));

    return {
      output: { path: file.path, notes },
      sources: notes.map((note) => note.path),
    };
  }

  private async getBacklinks(path: string): Promise<RlmToolExecutionResult> {
    const file = this.getMarkdownFile(path);
    if (!file) {
      throw new Error(`Note not found: ${path}`);
    }

    const notes = Object.entries(this.settings.app.metadataCache.resolvedLinks)
      .filter(([sourcePath, destinations]) => {
        return sourcePath !== file.path && typeof destinations[file.path] === "number";
      })
      .filter(([sourcePath]) => !this.isIgnored(sourcePath))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourcePath]) => ({
        path: sourcePath,
        title: this.titleFromPath(sourcePath),
      }));

    return {
      output: { path: file.path, notes },
      sources: notes.map((note) => note.path),
    };
  }

  private async summarizeText(text: string, instruction: string, depth: number): Promise<RlmToolExecutionResult> {
    const summary = await this.summarizeCallback(text, instruction, depth);
    return {
      output: {
        instruction,
        summary,
      },
      sources: [],
    };
  }

  private parseArguments(raw: string) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Tool arguments must be an object.");
      }

      return parsed as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Tool arguments are not valid JSON: ${message}`);
    }
  }

  private requireString(args: Record<string, unknown>, key: string) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Tool argument '${key}' must be a non-empty string.`);
    }

    return value.trim();
  }

  private createPreview(content: string, index: number, length: number) {
    const start = Math.max(0, index - 140);
    const end = Math.min(content.length, index + length + 140);
    return content.slice(start, end).replace(/\s+/g, " ").trim();
  }

  private getMarkdownFile(path: string) {
    const normalized = this.normalizePath(path);
    const file = this.settings.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile && file.extension === "md" && !this.isIgnored(file.path)) {
      return file;
    }

    return null;
  }

  private isIgnored(path: string) {
    const normalized = this.normalizePath(path);
    return this.settings.ignoredFolders.some((folder) => {
      return normalized === folder || normalized.startsWith(`${folder}/`);
    });
  }

  private normalizePath(path: string) {
    return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  private titleFromPath(path: string) {
    return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  }
}

