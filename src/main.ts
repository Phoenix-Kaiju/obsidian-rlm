import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

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
  maxElapsedSeconds: 60,
};

type RlmScope = "current-note" | "selection" | "folder" | "vault";

interface RlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  answerFolder: string;
  maxToolCalls: number;
  maxNotesRead: number;
  maxSearchResults: number;
  maxFolderNotesListed: number;
  maxElapsedSeconds: number;
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
}

export default class RlmPlugin extends Plugin {
  settings: RlmSettings;
  private lastResult: RlmResult | null = null;

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

    await this.activateResultView();

    const result: RlmResult = {
      question: request.question,
      scope: request.scope,
      answer: [
        "RLM command scaffold is ready.",
        "",
        "The next implementation slice is the LM Studio tool-calling loop.",
        "This placeholder confirms the command, modal, result panel, and answer-note flow are wired.",
      ].join("\n"),
      sources: this.initialSources(request),
      budgetStatus: this.formatBudgetStatus(),
    };

    this.lastResult = result;
    this.refreshResultViews();
  }

  async createAnswerNote(result: RlmResult) {
    await this.ensureFolder(this.settings.answerFolder);

    const fileName = `${this.timestamp()}-${this.slugify(result.question)}.md`;
    const path = `${this.settings.answerFolder}/${fileName}`;
    const content = this.formatAnswerNote(result);
    const file = await this.app.vault.create(path, content);

    await this.app.workspace.getLeaf(false).openFile(file);
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

  private initialSources(request: RlmRequest) {
    const sources = new Set<string>();

    if (request.notePath) {
      sources.add(request.notePath);
    }

    if (request.folderPath) {
      sources.add(request.folderPath);
    }

    return Array.from(sources);
  }

  private formatBudgetStatus() {
    return [
      `max tool calls: ${this.settings.maxToolCalls}`,
      `max notes read: ${this.settings.maxNotesRead}`,
      `max search results: ${this.settings.maxSearchResults}`,
      `max elapsed: ${this.settings.maxElapsedSeconds}s`,
    ].join(", ");
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
  private question = "";
  private folderPath = "";

  constructor(
    app: App,
    private readonly request: Omit<RlmRequest, "question">,
    private readonly onSubmit: (request: RlmRequest) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Ask RLM");
    contentEl.empty();

    if (this.request.scope === "folder") {
      new Setting(contentEl)
        .setName("Folder")
        .addText((text) => text
          .setPlaceholder("Folder path")
          .onChange((value) => {
            this.folderPath = value;
          }));
    }

    new Setting(contentEl)
      .setName("Question")
      .addTextArea((text) => {
        text
          .setPlaceholder("What do you want to know?")
          .onChange((value) => {
            this.question = value;
          });
        text.inputEl.rows = 5;
      });

    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("Ask")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit({
            ...this.request,
            question: this.question,
            folderPath: this.request.scope === "folder" ? this.folderPath : undefined,
          });
        }));
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

    new Setting(container as HTMLElement)
      .addButton((button) => button
        .setButtonText("Create answer note")
        .onClick(async () => {
          await this.plugin.createAnswerNote(result);
        }));
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
    this.addNumberSetting("Max elapsed seconds", "maxElapsedSeconds");
  }

  private addNumberSetting(name: string, key: keyof Pick<RlmSettings,
    "maxToolCalls" |
    "maxNotesRead" |
    "maxSearchResults" |
    "maxFolderNotesListed" |
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

