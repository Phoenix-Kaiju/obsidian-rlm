import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { VaultContextReaders, VaultContextResult } from "./context";
import { RlmToolLoop } from "./llm";

const VIEW_TYPE_RLM_RESULTS = "rlm-results";
const DEFAULT_SETTINGS: RlmSettings = {
  baseUrl: "http://localhost:1234/v1",
  apiKey: "",
  model: "",
  answerFolder: "RLM Answers",
  maxToolCalls: 20,
  maxNotesRead: 10,
  maxSearchResults: 20,
  maxFolderNotesListed: 100,
  maxNoteCharacters: 12000,
  maxTotalCharacters: 40000,
  maxToolDepth: 2,
  maxElapsedSeconds: 60,
  ignoredFolders: ".obsidian,RLM Answers",
};

export type RlmScope = "current-note" | "selection" | "folder" | "vault";

export interface RlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  answerFolder: string;
  maxToolCalls: number;
  maxNotesRead: number;
  maxSearchResults: number;
  maxFolderNotesListed: number;
  maxNoteCharacters: number;
  maxTotalCharacters: number;
  maxToolDepth: number;
  maxElapsedSeconds: number;
  ignoredFolders: string;
}

interface RlmRequest {
  question: string;
  scope: RlmScope;
  notePath?: string;
  selectedText?: string;
  folderPath?: string;
}

interface RlmResult {
  question: string;
  scope: RlmScope;
  answer: string;
  sources: string[];
  budgetStatus: string;
  status?: "loading" | "complete" | "error";
  canCancel?: boolean;
}

export default class RlmPlugin extends Plugin {
  settings: RlmSettings;
  private lastResult: RlmResult | null = null;
  private activeRequestId: number | null = null;
  private nextRequestId = 1;

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_RLM_RESULTS,
      (leaf) => new RlmResultView(leaf, this),
    );

    this.addCommand({
      id: "ask-current-note",
      name: "Ask about current note",
      callback: () => this.askAboutCurrentNote(),
    });

    this.addCommand({
      id: "ask-selection",
      name: "Ask about selection",
      editorCallback: (editor, view) => {
        const selectedText = editor.getSelection();
        const file = view.file;

        if (!selectedText.trim()) {
          new Notice("Select text before asking RLM about a selection.");
          return;
        }

        new RlmQuestionModal(this.app, {
          scope: "selection",
          notePath: file?.path,
          selectedText,
        }, (request) => this.runRequest(request)).open();
      },
    });

    this.addCommand({
      id: "ask-folder",
      name: "Ask about folder",
      callback: () => {
        new RlmQuestionModal(this.app, {
          scope: "folder",
        }, (request) => this.runRequest(request)).open();
      },
    });

    this.addCommand({
      id: "ask-vault",
      name: "Ask about vault",
      callback: () => {
        new RlmQuestionModal(this.app, {
          scope: "vault",
        }, (request) => this.runRequest(request)).open();
      },
    });

    this.addSettingTab(new RlmSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RLM_RESULTS);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async askAboutCurrentNote() {
    const file = this.app.workspace.getActiveFile();

    if (!file) {
      new Notice("Open a note before asking RLM about the current note.");
      return;
    }

    new RlmQuestionModal(this.app, {
      scope: "current-note",
      notePath: file.path,
    }, (request) => this.runRequest(request)).open();
  }

  async runRequest(request: RlmRequest) {
    if (!request.question.trim()) {
      new Notice("Enter a question for RLM.");
      return;
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.activeRequestId = requestId;

    await this.activateResultView();

    const context = await this.collectContext(request);
    this.lastResult = {
      question: request.question,
      scope: request.scope,
      answer: "Running RLM tool loop...",
      sources: context.records.map((record) => record.path),
      budgetStatus: this.formatBudgetStatus(),
      status: "loading",
      canCancel: true,
    };
    this.refreshResultViews();

    try {
      const toolLoop = new RlmToolLoop(this.settings, {
        app: this.app,
        maxNotesRead: this.settings.maxNotesRead,
        maxSearchResults: this.settings.maxSearchResults,
        maxFolderNotesListed: this.settings.maxFolderNotesListed,
        maxNoteCharacters: this.settings.maxNoteCharacters,
        maxTotalCharacters: this.settings.maxTotalCharacters,
        initialCharactersUsed: context.totalCharacters,
        ignoredFolders: this.parseIgnoredFolders(),
        shouldCancel: () => this.activeRequestId !== requestId,
      });

      const response = await toolLoop.run({
        question: request.question,
        scope: request.scope,
        context,
        settings: this.settings,
      });

      if (this.activeRequestId !== requestId) {
        return;
      }

      this.lastResult = {
        question: request.question,
        scope: request.scope,
        answer: response.answer,
        sources: response.sources,
        budgetStatus: this.formatBudgetStatus(response.toolCallsUsed, response.depth, context.totalCharacters),
        status: "complete",
        canCancel: false,
      };
    } catch (error) {
      if (this.activeRequestId !== requestId) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.lastResult = {
        question: request.question,
        scope: request.scope,
        answer: [
          "RLM request failed.",
          "",
          message,
          "",
          this.formatContextSummary(context),
        ].join("\n"),
        sources: context.records.map((record) => record.path),
        budgetStatus: this.formatBudgetStatus(undefined, undefined, context.totalCharacters),
        status: "error",
        canCancel: false,
      };
    } finally {
      if (this.activeRequestId === requestId) {
        this.activeRequestId = null;
      }
    }

    this.refreshResultViews();
  }

  cancelActiveRequest() {
    if (this.activeRequestId === null) {
      return;
    }

    this.activeRequestId = null;
    if (this.lastResult) {
      this.lastResult = {
        ...this.lastResult,
        answer: "RLM request cancelled.",
        status: "error",
        canCancel: false,
      };
      this.refreshResultViews();
    }
  }

  async createAnswerNote(result: RlmResult) {
    await this.ensureFolder(this.settings.answerFolder);

    const fileName = `${this.timestamp()}-${this.slugify(result.question)}.md`;
    const path = `${this.settings.answerFolder}/${fileName}`;
    const content = this.formatAnswerNote(result);
    const file = await this.app.vault.create(path, content);

    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async copyAnswer(result: RlmResult) {
    await navigator.clipboard.writeText(this.formatAnswerExport(result));
    new Notice("RLM answer copied.");
  }

  async insertAnswerIntoActiveNote(result: RlmResult) {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = markdownView?.editor;

    if (!editor) {
      throw new Error("Open a Markdown note before inserting an RLM answer.");
    }

    const prefix = editor.getValue().endsWith("\n") ? "\n" : "\n\n";
    editor.replaceSelection(`${prefix}${this.formatAnswerInsert(result)}\n`);
    new Notice("RLM answer inserted into the active note.");
  }

  getLastResult() {
    return this.lastResult;
  }

  private async activateResultView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RLM_RESULTS);
    let leaf = leaves[0];

    if (!leaf) {
      const rightLeaf = this.app.workspace.getRightLeaf(false);
      if (!rightLeaf) {
        new Notice("Unable to open RLM result panel.");
        return;
      }

      leaf = rightLeaf;
      await leaf.setViewState({
        type: VIEW_TYPE_RLM_RESULTS,
        active: true,
      });
    }

    this.app.workspace.revealLeaf(leaf);
  }

  private refreshResultViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RLM_RESULTS)) {
      const view = leaf.view;
      if (view instanceof RlmResultView) {
        view.render();
      }
    }
  }

  private async collectContext(request: RlmRequest): Promise<VaultContextResult> {
    const readers = new VaultContextReaders(this.app, {
      maxNotesRead: this.settings.maxNotesRead,
      maxFolderNotesListed: this.settings.maxFolderNotesListed,
      maxNoteCharacters: this.settings.maxNoteCharacters,
      maxTotalCharacters: this.settings.maxTotalCharacters,
      ignoredFolders: this.parseIgnoredFolders(),
    });

    if (request.scope === "current-note" && request.notePath) {
      return readers.readCurrentNote(request.notePath);
    }

    if (request.scope === "selection") {
      return readers.readSelection(request.notePath, request.selectedText ?? "");
    }

    if (request.scope === "folder" && request.folderPath) {
      return readers.readFolder(request.folderPath);
    }

    if (request.scope === "vault") {
      return readers.readVault();
    }

    return {
      records: [],
      skipped: [`No context reader matched scope: ${request.scope}`],
      limitHit: false,
      totalCharacters: 0,
    };
  }

  private formatContextSummary(context: VaultContextResult) {
    const lines = [
      `Collected ${context.records.length} context record${context.records.length === 1 ? "" : "s"}.`,
    ];

    if (context.records.length > 0) {
      lines.push("");
      lines.push("Records:");
      for (const record of context.records) {
        const truncation = record.truncated ? ", truncated" : "";
        lines.push(`- ${record.path} (${record.content.length} chars${truncation})`);
      }
    }

    if (context.skipped.length > 0) {
      lines.push("");
      lines.push("Skipped:");
      for (const skipped of context.skipped.slice(0, 10)) {
        lines.push(`- ${skipped}`);
      }
    }

    if (context.limitHit) {
      lines.push("");
      lines.push("One or more context limits were reached.");
    }

    return lines.join("\n");
  }

  private formatBudgetStatus(toolCallsUsed?: number, depth?: number, totalCharacters?: number) {
    return [
      `max tool calls: ${this.settings.maxToolCalls}`,
      `max depth: ${this.settings.maxToolDepth}`,
      `max notes read: ${this.settings.maxNotesRead}`,
      `max search results: ${this.settings.maxSearchResults}`,
      `max note chars: ${this.settings.maxNoteCharacters}`,
      `max total chars: ${this.settings.maxTotalCharacters}`,
      `max elapsed: ${this.settings.maxElapsedSeconds}s`,
      typeof totalCharacters === "number" ? `chars collected: ${totalCharacters}` : "",
      typeof toolCallsUsed === "number" ? `tool calls used: ${toolCallsUsed}` : "",
      typeof depth === "number" ? `depth reached: ${depth}` : "",
    ].filter((value) => value.length > 0).join(", ");
  }

  private parseIgnoredFolders() {
    return this.settings.ignoredFolders
      .split(",")
      .map((folder) => folder.trim())
      .filter((folder) => folder.length > 0);
  }

  private async ensureFolder(folderPath: string) {
    const normalized = folderPath.trim().replace(/\/+$/, "");

    if (!normalized) {
      throw new Error("Answer folder cannot be empty.");
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!existing) {
      await this.app.vault.createFolder(normalized);
    }
  }

  private formatAnswerNote(result: RlmResult) {
    const sources = result.sources.length > 0
      ? result.sources.map((source) => `- [[${source.replace(/\.md$/, "")}]]`).join("\n")
      : "- No source notes captured yet.";

    return [
      `# RLM Answer`,
      "",
      `Question: ${result.question}`,
      "",
      `Scope: ${result.scope}`,
      "",
      "## Answer",
      "",
      result.answer,
      "",
      "## Sources",
      "",
      sources,
      "",
      "## Budget",
      "",
      result.budgetStatus,
      "",
    ].join("\n");
  }

  private formatAnswerExport(result: RlmResult) {
    return [
      result.answer,
      "",
      "Sources:",
      ...this.formatSourceLinks(result.sources),
    ].join("\n");
  }

  private formatAnswerInsert(result: RlmResult) {
    return [
      "## RLM Answer",
      "",
      result.answer,
      "",
      "### Sources",
      ...this.formatSourceLinks(result.sources),
    ].join("\n");
  }

  private formatSourceLinks(sources: string[]) {
    if (sources.length === 0) {
      return ["- No source notes captured yet."];
    }

    return sources.map((source) => `- [[${source.replace(/\.md$/, "")}]]`);
  }

  private timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  private slugify(value: string) {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);

    return slug || "answer";
  }
}

class RlmQuestionModal extends Modal {
  private static readonly MIN_WIDTH = 320;
  private static readonly DEFAULT_WIDTH = 720;
  private static readonly MIN_HEIGHT = 180;
  private static readonly DEFAULT_HEIGHT = 220;
  private static readonly MAX_HEIGHT = 420;
  private static readonly DEFAULT_TOP = 68;
  private static readonly VIEWPORT_MARGIN = 24;
  private question = "";
  private folderPath = "";
  private composerInput?: HTMLTextAreaElement;
  private resizeCleanup?: () => void;
  private dragCleanup?: () => void;
  private manualHeight?: number;

  constructor(
    app: App,
    private readonly request: Omit<RlmRequest, "question">,
    private readonly onSubmit: (request: RlmRequest) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { containerEl, contentEl, modalEl, titleEl } = this;
    titleEl.setText("Ask RLM");
    contentEl.empty();
    containerEl.addClass("rlm-question-modal-container");
    contentEl.addClass("rlm-question-modal");
    modalEl.addClass("rlm-question-modal-shell");
    const { minWidth, maxWidth } = this.getWidthBounds();
    const { minHeight, maxHeight } = this.getHeightBounds();
    modalEl.style.width = `${Math.min(RlmQuestionModal.DEFAULT_WIDTH, maxWidth)}px`;
    modalEl.style.minWidth = `${minWidth}px`;
    modalEl.style.maxWidth = `${maxWidth}px`;
    modalEl.style.height = `${Math.min(RlmQuestionModal.DEFAULT_HEIGHT, maxHeight)}px`;
    modalEl.style.minHeight = `${minHeight}px`;
    modalEl.style.maxHeight = `${maxHeight}px`;
    modalEl.style.left = "50%";
    modalEl.style.top = `${RlmQuestionModal.DEFAULT_TOP}%`;

    if (this.request.scope === "folder") {
      const folderRow = contentEl.createDiv({ cls: "rlm-folder-row" });
      const folderInput = folderRow.createEl("input", {
        cls: "rlm-folder-input",
        type: "text",
      });
      folderInput.placeholder = "Folder path";
      folderInput.addEventListener("input", () => {
        this.folderPath = folderInput.value;
      });
    }

    const composer = contentEl.createDiv({ cls: "rlm-question-composer" });
    const textArea = composer.createEl("textarea", {
      cls: "rlm-question-input",
    });
    this.composerInput = textArea;
    textArea.placeholder = "What do you want to know?";
    textArea.addEventListener("input", () => {
      this.question = textArea.value;
      this.syncComposerHeight();
    });
    textArea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });

    const footer = composer.createDiv({ cls: "rlm-question-footer" });
    footer.createDiv({
      cls: "rlm-question-hint",
      text: "Ctrl+Enter to ask",
    });

    const askButton = footer.createEl("button", {
      cls: "mod-cta",
      text: "Ask",
    });

    const submit = () => {
      this.close();
      this.onSubmit({
        ...this.request,
        question: this.question,
        folderPath: this.request.scope === "folder" ? this.folderPath : undefined,
      });
    };

    askButton.addEventListener("click", submit);
    this.installDragging();
    this.installResizeHandles();
    window.setTimeout(() => {
      this.syncComposerHeight();
      textArea.focus();
    }, 0);
  }

  onClose() {
    this.resizeCleanup?.();
    this.dragCleanup?.();
    this.resizeCleanup = undefined;
    this.dragCleanup = undefined;
    this.composerInput = undefined;
    this.manualHeight = undefined;
    this.containerEl.removeClass("rlm-question-modal-container");
    this.contentEl.removeClass("rlm-question-modal");
    this.modalEl.removeClass("rlm-question-modal-shell");
    this.modalEl.removeAttribute("style");
  }

  private syncComposerHeight() {
    const textArea = this.composerInput;
    if (!textArea) {
      return;
    }

    textArea.style.height = "0px";
    const nextHeight = Math.min(Math.max(textArea.scrollHeight, 72), 220);
    textArea.style.height = `${nextHeight}px`;

    const { minHeight, maxHeight } = this.getHeightBounds();
    const autoHeight = Math.min(
      Math.max(nextHeight + 128, Math.min(RlmQuestionModal.DEFAULT_HEIGHT, maxHeight)),
      maxHeight,
    );
    const modalHeight = this.manualHeight
      ? this.clamp(Math.max(this.manualHeight, autoHeight), minHeight, maxHeight)
      : autoHeight;
    this.modalEl.style.height = `${modalHeight}px`;
  }

  private installResizeHandles() {
    const directions = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
    const cleanup: Array<() => void> = [];

    for (const direction of directions) {
      const handle = this.modalEl.createDiv({
        cls: `rlm-resize-handle rlm-resize-${direction}`,
      });
      handle.setAttribute("aria-hidden", "true");
      const onPointerDown = (event: PointerEvent) => this.startResize(direction, event);
      handle.addEventListener("pointerdown", onPointerDown);
      cleanup.push(() => handle.removeEventListener("pointerdown", onPointerDown));
      cleanup.push(() => handle.remove());
    }

    this.resizeCleanup = () => {
      for (const dispose of cleanup.reverse()) {
        dispose();
      }
    };
  }

  private installDragging() {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest(".rlm-resize-handle")) {
        return;
      }

      if (target.closest("button, textarea, input, a")) {
        return;
      }

      this.startDrag(event);
    };

    this.modalEl.addEventListener("pointerdown", onPointerDown);
    this.dragCleanup = () => {
      this.modalEl.removeEventListener("pointerdown", onPointerDown);
    };
  }

  private startDrag(event: PointerEvent) {
    event.preventDefault();

    const rect = this.modalEl.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const width = rect.width;
      const height = rect.height;
      const nextLeft = this.clamp(
        moveEvent.clientX - offsetX + width / 2,
        width / 2 + 16,
        window.innerWidth - width / 2 - 16,
      );
      const nextTop = this.clamp(
        moveEvent.clientY - offsetY + height / 2,
        height / 2 + 16,
        window.innerHeight - height / 2 - 16,
      );

      this.modalEl.style.left = `${nextLeft}px`;
      this.modalEl.style.top = `${nextTop}px`;
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  private startResize(direction: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw", event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();

    const rect = this.modalEl.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const startLeft = rect.left + rect.width / 2;
    const startTop = rect.top + rect.height / 2;
    const { minWidth, maxWidth } = this.getWidthBounds();
    const { minHeight, maxHeight } = this.getHeightBounds();

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let width = startWidth;
      let height = startHeight;
      let left = startLeft;
      let top = startTop;

      if (direction.includes("e")) {
        width = this.clamp(startWidth + dx, minWidth, maxWidth);
      }
      if (direction.includes("w")) {
        width = this.clamp(startWidth - dx, minWidth, maxWidth);
        left = startLeft + (startWidth - width) / 2 + dx / 2;
      }
      if (direction.includes("s")) {
        height = this.clamp(startHeight + dy, minHeight, maxHeight);
      }
      if (direction.includes("n")) {
        height = this.clamp(startHeight - dy, minHeight, maxHeight);
        top = startTop + (startHeight - height) / 2 + dy / 2;
      }

      left = this.clamp(left, width / 2 + 16, window.innerWidth - width / 2 - 16);
      top = this.clamp(top, height / 2 + 16, window.innerHeight - height / 2 - 16);

      this.modalEl.style.width = `${width}px`;
      this.modalEl.style.height = `${height}px`;
      this.modalEl.style.left = `${left}px`;
      this.modalEl.style.top = `${top}px`;

      if (direction.includes("n") || direction.includes("s")) {
        this.manualHeight = height;
      }
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
  }

  private getWidthBounds() {
    const maxWidth = Math.max(
      window.innerWidth - RlmQuestionModal.VIEWPORT_MARGIN * 2,
      260,
    );
    return {
      minWidth: Math.min(RlmQuestionModal.MIN_WIDTH, maxWidth),
      maxWidth,
    };
  }

  private getHeightBounds() {
    const maxHeight = Math.max(
      Math.min(window.innerHeight - 64, RlmQuestionModal.MAX_HEIGHT),
      160,
    );
    return {
      minHeight: Math.min(RlmQuestionModal.MIN_HEIGHT, maxHeight),
      maxHeight,
    };
  }
}

class RlmResultView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: RlmPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_RLM_RESULTS;
  }

  getDisplayText() {
    return "RLM";
  }

  async onOpen() {
    this.render();
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("rlm-result-view");

    const result = this.plugin.getLastResult();

    const header = container.createDiv({ cls: "rlm-result-header" });
    header.createDiv({ cls: "rlm-result-title", text: "RLM" });

    if (!result) {
      container.createDiv({
        cls: "rlm-empty-state",
        text: "Run an RLM command to ask about a note, selection, folder, or vault.",
      });
      return;
    }

    header.createDiv({ cls: "rlm-result-meta", text: result.scope });

    container.createEl("h3", { text: result.question });
    container.createDiv({ cls: "rlm-result-answer", text: result.answer });

    container.createEl("h4", { text: "Sources" });
    const sourceList = container.createEl("ul", { cls: "rlm-source-list" });
    if (result.sources.length === 0) {
      sourceList.createEl("li", { text: "No source notes captured yet." });
    } else {
      for (const source of result.sources) {
        const item = sourceList.createEl("li");
        item.createEl("a", { text: source, href: source });
      }
    }

    container.createEl("h4", { text: "Budget" });
    container.createDiv({ cls: "rlm-result-meta", text: result.budgetStatus });

    const actions = container.createDiv({ cls: "rlm-result-actions" });

    const addActionButton = (label: string, onClick: () => Promise<void> | void) => {
      const button = actions.createEl("button", { text: label });
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await onClick();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(message);
        } finally {
          button.disabled = false;
        }
      });
    };

    addActionButton("Copy answer", () => this.plugin.copyAnswer(result));
    addActionButton("Insert into note", () => this.plugin.insertAnswerIntoActiveNote(result));
    addActionButton("Create answer note", () => this.plugin.createAnswerNote(result));

    if (result.canCancel) {
      const cancelButton = actions.createEl("button", { text: "Cancel request" });
      cancelButton.addEventListener("click", () => {
        this.plugin.cancelActiveRequest();
      });
    }
  }
}

class RlmSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: RlmPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("LM Studio base URL")
      .setDesc("OpenAI-compatible API base URL.")
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.baseUrl)
        .setValue(this.plugin.settings.baseUrl)
        .onChange(async (value) => {
          this.plugin.settings.baseUrl = value.trim() || DEFAULT_SETTINGS.baseUrl;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Optional for LM Studio.")
      .addText((text) => text
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Model")
      .setDesc("The LM Studio model identifier to request.")
      .addText((text) => text
        .setPlaceholder("Select or load a model in LM Studio")
        .setValue(this.plugin.settings.model)
        .onChange(async (value) => {
          this.plugin.settings.model = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Answer folder")
      .addText((text) => text
        .setValue(this.plugin.settings.answerFolder)
        .onChange(async (value) => {
          this.plugin.settings.answerFolder = value.trim() || DEFAULT_SETTINGS.answerFolder;
          await this.plugin.saveSettings();
        }));

    this.addNumberSetting("Max tool calls", "maxToolCalls");
    this.addNumberSetting("Max notes read", "maxNotesRead");
    this.addNumberSetting("Max search results", "maxSearchResults");
    this.addNumberSetting("Max folder notes listed", "maxFolderNotesListed");
    this.addNumberSetting("Max note characters", "maxNoteCharacters");
    this.addNumberSetting("Max total characters", "maxTotalCharacters");
    this.addNumberSetting("Max tool depth", "maxToolDepth");
    this.addNumberSetting("Max elapsed seconds", "maxElapsedSeconds");

    new Setting(containerEl)
      .setName("Ignored folders")
      .setDesc("Comma-separated vault-relative folder paths.")
      .addText((text) => text
        .setValue(this.plugin.settings.ignoredFolders)
        .onChange(async (value) => {
          this.plugin.settings.ignoredFolders = value;
          await this.plugin.saveSettings();
        }));
  }

  private addNumberSetting(name: string, key: keyof Pick<RlmSettings,
    "maxToolCalls" |
    "maxNotesRead" |
    "maxSearchResults" |
    "maxFolderNotesListed" |
    "maxNoteCharacters" |
    "maxTotalCharacters" |
    "maxToolDepth" |
    "maxElapsedSeconds"
  >) {
    new Setting(this.containerEl)
      .setName(name)
      .addText((text) => text
        .setValue(String(this.plugin.settings[key]))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            this.plugin.settings[key] = parsed;
            await this.plugin.saveSettings();
          }
        }));
  }
}

