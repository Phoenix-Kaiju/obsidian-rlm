import { requestUrl } from "obsidian";
import type { VaultContextResult } from "./context";
import type { RlmScope, RlmSettings } from "./main";
import { RlmToolExecutor, type RlmToolExecutionSettings } from "./tools";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface RlmToolLoopResult {
  answer: string;
  sources: string[];
  toolCallsUsed: number;
  depth: number;
}

interface RlmToolLoopParams {
  question: string;
  scope: RlmScope;
  context: VaultContextResult;
  settings: RlmSettings;
  depth?: number;
}

export class RlmToolLoop {
  private readonly toolExecutor: RlmToolExecutor;

  constructor(
    private readonly settings: RlmSettings,
    toolSettings: RlmToolExecutionSettings,
  ) {
    this.toolExecutor = new RlmToolExecutor(toolSettings, (text, instruction, depth) =>
      this.summarizeText(text, instruction, depth));
  }

  async run(params: RlmToolLoopParams): Promise<RlmToolLoopResult> {
    const depth = params.depth ?? 0;
    if (depth > params.settings.maxToolDepth) {
      throw new Error(`Maximum tool depth (${params.settings.maxToolDepth}) exceeded.`);
    }
    const deadline = Date.now() + params.settings.maxElapsedSeconds * 1000;

    if (!params.settings.model.trim()) {
      throw new Error("Set an LM Studio model in RLM settings before asking a question.");
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: this.buildSystemPrompt(params.settings.maxToolCalls, params.settings.maxToolDepth),
      },
      {
        role: "user",
        content: this.buildUserPrompt(params.question, params.scope, params.context),
      },
    ];

    const sources = new Set<string>(params.context.records.map((record: { path: string }) => record.path));
    let toolCallsUsed = 0;

    for (let iteration = 0; iteration < params.settings.maxToolCalls; iteration += 1) {
      this.throwIfCancelled();
      this.throwIfExpired(deadline);
      const assistantMessage = await this.createChatCompletion(messages, true);
      this.throwIfCancelled();
      this.throwIfExpired(deadline);
      const validatedToolCalls = this.validateToolCalls(assistantMessage.tool_calls);

      if (validatedToolCalls.length === 0) {
        const answer = assistantMessage.content?.trim();
        if (!answer) {
          throw new Error("LM Studio returned neither tool calls nor a final answer.");
        }

        return {
          answer,
          sources: Array.from(sources),
          toolCallsUsed,
          depth,
        };
      }

      if (toolCallsUsed + validatedToolCalls.length > params.settings.maxToolCalls) {
        throw new Error(`Maximum tool calls (${params.settings.maxToolCalls}) exceeded.`);
      }

      messages.push({
        role: "assistant",
        content: assistantMessage.content ?? null,
        tool_calls: validatedToolCalls,
      });

      for (const toolCall of validatedToolCalls) {
        this.throwIfCancelled();
        this.throwIfExpired(deadline);
        const result = await this.toolExecutor.execute(toolCall, depth, params.settings.maxToolDepth);
        toolCallsUsed += 1;
        for (const source of result.sources) {
          sources.add(source);
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.output),
        });
      }
    }

    throw new Error(`Maximum tool calls (${params.settings.maxToolCalls}) exceeded.`);
  }

  private async summarizeText(text: string, instruction: string, depth: number) {
    if (depth + 1 > this.settings.maxToolDepth) {
      throw new Error(`Maximum tool depth (${this.settings.maxToolDepth}) exceeded.`);
    }

    const response = await this.createChatCompletion([
      {
        role: "system",
        content: [
          "You are a focused summarization tool for an Obsidian plugin.",
          "Follow the instruction exactly and return only the result.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Instruction: ${instruction}`,
          "",
          "Text:",
          text,
        ].join("\n"),
      },
    ], false);

    return response.content?.trim() ?? "";
  }

  private async createChatCompletion(messages: ChatMessage[], includeTools: boolean) {
    const headers: Record<string, string> = {};
    const apiKey = this.settings.apiKey.trim();

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await requestUrl({
      url: `${this.settings.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      method: "POST",
      contentType: "application/json",
      headers,
      body: JSON.stringify({
        model: this.settings.model,
        messages,
        ...(includeTools
          ? {
            tools: this.toolExecutor.getDefinitions(),
            tool_choice: "auto",
          }
          : {}),
      }),
    });

    if (response.status >= 400) {
      const payload = response.json as OpenAiChatCompletionResponse;
      const message = payload.error?.message ?? response.text;
      throw new Error(`LM Studio request failed (${response.status}): ${message}`);
    }

    const payload = response.json as OpenAiChatCompletionResponse;
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error("LM Studio returned an empty completion response.");
    }

    return {
      content: typeof message.content === "string" ? message.content : null,
      tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    };
  }

  private validateToolCalls(toolCalls: OpenAiToolCall[]) {
    const validNames = new Set(this.toolExecutor.getDefinitions().map((tool) => tool.function.name));

    return toolCalls.map((toolCall) => {
      if (!toolCall.id || toolCall.type !== "function") {
        throw new Error("LM Studio returned an invalid tool call envelope.");
      }

      if (!validNames.has(toolCall.function.name)) {
        throw new Error(`LM Studio requested an unknown tool: ${toolCall.function.name}`);
      }

      return toolCall;
    });
  }

  private buildSystemPrompt(maxToolCalls: number, maxToolDepth: number) {
    return [
      "You are an Obsidian vault assistant running inside the RLM plugin.",
      "Use the provided tools to inspect notes and metadata instead of inventing facts.",
      `You may use at most ${maxToolCalls} tool calls in this request.`,
      `Recursive summarization depth is limited to ${maxToolDepth}.`,
      "When you have enough information, answer directly and keep the answer grounded in the inspected notes.",
      "If you cite sources in prose, use vault-relative note paths.",
    ].join("\n");
  }

  private buildUserPrompt(question: string, scope: RlmScope, context: VaultContextResult) {
    const lines = [
      `Question: ${question}`,
      `Scope: ${scope}`,
      "",
      "Initial context:",
    ];

    if (context.records.length === 0) {
      lines.push("No initial records were collected.");
    } else {
      for (const record of context.records) {
        lines.push(`- ${record.path}`);
      }
    }

    if (context.records.length > 0) {
      lines.push("");
      lines.push("Initial record previews:");
      for (const record of context.records) {
        lines.push(`## ${record.path}`);
        lines.push(this.previewContextRecord(scope, record.content));
      }
    }

    if (context.skipped.length > 0) {
      lines.push("");
      lines.push("Skipped during initial collection:");
      for (const skipped of context.skipped.slice(0, 10)) {
        lines.push(`- ${skipped}`);
      }
    }

    return lines.join("\n");
  }

  private previewContextRecord(scope: RlmScope, content: string) {
    if (scope === "current-note" || scope === "selection") {
      return content;
    }

    return content.slice(0, 800);
  }

  private throwIfCancelled() {
    if (this.toolExecutor.shouldCancel()) {
      throw new Error("Request cancelled.");
    }
  }

  private throwIfExpired(deadline: number) {
    if (Date.now() > deadline) {
      throw new Error(`Maximum elapsed time (${this.settings.maxElapsedSeconds}s) exceeded.`);
    }
  }
}
