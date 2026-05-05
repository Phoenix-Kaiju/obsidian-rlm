import { App, TAbstractFile, TFile, TFolder } from "obsidian";

export interface ContextReaderLimits {
  maxNotesRead: number;
  maxFolderNotesListed: number;
  maxNoteCharacters: number;
  maxTotalCharacters: number;
  ignoredFolders: string[];
}

export interface VaultContextRecord {
  path: string;
  title: string;
  content: string;
  truncated: boolean;
}

export interface VaultContextResult {
  records: VaultContextRecord[];
  skipped: string[];
  limitHit: boolean;
  totalCharacters: number;
}

export class VaultContextReaders {
  constructor(
    private readonly app: App,
    private readonly limits: ContextReaderLimits,
  ) {}

  async readCurrentNote(path: string): Promise<VaultContextResult> {
    const file = this.getMarkdownFile(path);
    if (!file) {
      return this.emptyResult(`Current note is not a Markdown file: ${path}`);
    }

    const budget = this.createCharacterBudget();
    const record = await this.readFileRecord(file, budget);

    return {
      records: [record],
      skipped: [...budget.limitMessages],
      limitHit: budget.limitMessages.length > 0,
      totalCharacters: budget.usedCharacters,
    };
  }

  readSelection(notePath: string | undefined, selectedText: string): VaultContextResult {
    const budget = this.createCharacterBudget();
    const content = this.truncateContent(selectedText, budget);
    const title = notePath ? this.titleFromPath(notePath) : "Selection";

    return {
      records: [{
        path: notePath ?? "selection",
        title,
        content: content.value,
        truncated: content.truncated,
      }],
      skipped: [...budget.limitMessages],
      limitHit: budget.limitMessages.length > 0,
      totalCharacters: budget.usedCharacters,
    };
  }

  async readFolder(folderPath: string): Promise<VaultContextResult> {
    const folder = this.app.vault.getAbstractFileByPath(this.normalizePath(folderPath));

    if (!(folder instanceof TFolder)) {
      return this.emptyResult(`Folder not found: ${folderPath}`);
    }

    const allFiles = this.collectMarkdownFiles(folder);
    const files = allFiles.slice(0, this.limits.maxFolderNotesListed);
    const result = await this.readFiles(files);

    if (allFiles.length > this.limits.maxFolderNotesListed) {
      result.limitHit = true;
      result.skipped.push(
        `${allFiles.length - files.length} folder notes were skipped by max folder notes listed.`,
      );
    }

    return result;
  }

  async readVault(): Promise<VaultContextResult> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.isIgnored(file.path));

    return this.readFiles(files);
  }

  private async readFiles(files: TFile[]): Promise<VaultContextResult> {
    const records: VaultContextRecord[] = [];
    const skipped: string[] = [];
    const budget = this.createCharacterBudget();
    let limitHit = files.length > this.limits.maxNotesRead;

    for (const file of files) {
      if (records.length >= this.limits.maxNotesRead) {
        skipped.push(file.path);
        continue;
      }

      if (budget.remainingCharacters <= 0) {
        skipped.push(`${file.path} skipped because max total characters was reached.`);
        limitHit = true;
        continue;
      }

      records.push(await this.readFileRecord(file, budget));
    }

    return {
      records,
      skipped: [...skipped, ...budget.limitMessages],
      limitHit: limitHit || budget.limitMessages.length > 0,
      totalCharacters: budget.usedCharacters,
    };
  }

  private async readFileRecord(file: TFile, budget: CharacterBudget): Promise<VaultContextRecord> {
    const raw = await this.app.vault.cachedRead(file);
    const content = this.truncateContent(raw, budget);

    return {
      path: file.path,
      title: file.basename,
      content: content.value,
      truncated: content.truncated,
    };
  }

  private collectMarkdownFiles(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    const queue: TAbstractFile[] = [...folder.children];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item || this.isIgnored(item.path)) {
        continue;
      }

      if (item instanceof TFolder) {
        queue.push(...item.children);
        continue;
      }

      if (item instanceof TFile && item.extension === "md") {
        files.push(item);
      }
    }

    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private getMarkdownFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && file.extension === "md" && !this.isIgnored(file.path)) {
      return file;
    }

    return null;
  }

  private isIgnored(path: string): boolean {
    const normalizedPath = this.normalizePath(path);

    return this.limits.ignoredFolders.some((folder) => {
      const normalizedFolder = this.normalizePath(folder);
      return normalizedFolder.length > 0 &&
        (normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`));
    });
  }

  private truncateContent(value: string, budget: CharacterBudget) {
    const noteBounded = value.slice(0, this.limits.maxNoteCharacters);
    const noteTruncated = noteBounded.length < value.length;
    const finalValue = noteBounded.slice(0, budget.remainingCharacters);
    const totalTruncated = finalValue.length < noteBounded.length;

    budget.usedCharacters += finalValue.length;

    if (noteTruncated && !budget.limitMessages.includes(`A note was truncated at ${this.limits.maxNoteCharacters} characters.`)) {
      budget.limitMessages.push(`A note was truncated at ${this.limits.maxNoteCharacters} characters.`);
    }

    if (totalTruncated && !budget.limitMessages.includes(`The request hit the max total characters limit of ${this.limits.maxTotalCharacters}.`)) {
      budget.limitMessages.push(`The request hit the max total characters limit of ${this.limits.maxTotalCharacters}.`);
    }

    return {
      value: finalValue,
      truncated: noteTruncated || totalTruncated,
    };
  }

  private emptyResult(message: string): VaultContextResult {
    return {
      records: [],
      skipped: [message],
      limitHit: false,
      totalCharacters: 0,
    };
  }

  private createCharacterBudget(): CharacterBudget {
    return {
      maxTotalCharacters: this.limits.maxTotalCharacters,
      usedCharacters: 0,
      limitMessages: [],
      get remainingCharacters() {
        return Math.max(0, this.maxTotalCharacters - this.usedCharacters);
      },
    };
  }

  private titleFromPath(path: string) {
    return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  }

  private normalizePath(path: string) {
    return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }
}

interface CharacterBudget {
  maxTotalCharacters: number;
  usedCharacters: number;
  limitMessages: string[];
  readonly remainingCharacters: number;
}
