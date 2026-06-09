import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import i18n from "i18next";
import { z } from "zod";
/**
 * Reading Agent — AI-powered reading assistant using LangGraph ReAct agent
 *
 * Architecture:
 * 1. Uses LangGraph's createReactAgent for automatic tool-calling loop
 * 2. Uses getAvailableTools() and a lightweight router to keep tool sets focused
 * 3. Builds proper Zod schemas from ToolDefinition.parameters
 * 4. Real streaming via streamEvents API
 * 5. System prompt from system-prompt.ts
 */
import type { AIConfig, Book, SemanticContext, Skill } from "../../types";
import { createChatModel } from "../llm-provider";
import { buildSystemPrompt } from "../system-prompt";
import { ThinkTagStreamParser } from "../think-tag-parser";
import type { ToolDefinition, ToolParameter } from "../tools/tool-types";

const CHAPTER_REFERENCE_RE =
  /(?:第\s*)?[零〇一二两三四五六七八九十百千万\d]{1,8}\s*(?:章|卷|节|回|讲|篇|话)|这一章|这一节|chapter\s*\d+/iu;
const CHAPTER_REFERENCE_EXECUTION_LIMIT = 3;
const CHAPTER_TOOL_EXECUTION_LIMIT = 8;
const DEFAULT_RECURSION_LIMIT = 24;
const CHAPTER_TASK_RECURSION_LIMIT = 24;

const CHAPTER_TASK_TOOL_NAMES = new Set([
  "resolveChapterReference",
  "ragSearch",
  "ragContext",
  "summarize",
  "fallbackSearch",
  "fallbackChapterContext",
  "getCurrentChapter",
  "getSurroundingContext",
  "addCitation",
]);

const CHAPTER_LOOKUP_STOP_TOOL_NAMES = new Set([
  "resolveChapterReference",
  "ragSearch",
  "ragToc",
  "ragContext",
  "summarize",
  "extractEntities",
  "analyzeArguments",
  "findQuotes",
  "compareSections",
  "fallbackSearch",
  "fallbackToc",
  "fallbackChapterContext",
  "getCurrentChapter",
  "getSurroundingContext",
]);

function simplifyChapterLookupQuery(query: string, fallback: string): string {
  const source = (query || fallback).normalize("NFKC");
  const sanitizedSource = source.replace(
    /(?:这|那|哪)\s*一\s*(?:章|卷|节|回|讲|篇|话)/gu,
    " ",
  );
  const chapterNumber = sanitizedSource.match(
    /(?:第\s*)?([零〇一二两三四五六七八九十百千万\d]{1,8})\s*(?:章|卷|节|回|讲|篇|话)/u,
  );
  if (chapterNumber?.[1]) {
    return `第${chapterNumber[1].replace(/\s+/g, "")}章`;
  }

  const simplified = source
    .replace(
      /请问|帮我|看看|查一下|搜一下|告诉我|想知道|讲讲|说说|内容|讲了什么|讲什么|说了什么|这一章|那一章|这一节|那一节|是哪一章/gu,
      " ",
    )
    .replace(/[，。、“”"'`!！?？,:：;；()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!simplified) return source.trim();

  const segments = simplified
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  return segments[0] || simplified;
}

function buildSecondAttemptChapterLookupQuery(query: string, fallback: string): string {
  const source = (query || fallback).normalize("NFKC");
  return source
    .replace(
      /请问|帮我|看看|查一下|搜一下|告诉我|想知道|讲讲|说说|内容|讲了什么|讲什么|说了什么|这一章|那一章|这一节|那一节|是哪一章/gu,
      " ",
    )
    .replace(/[，。、“”"'`!！?？,:：;；()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildChapterReferenceLimitResult(
  lastResult: unknown,
  attemptedQueries: string[],
): Record<string, unknown> {
  const base =
    lastResult && typeof lastResult === "object" ? (lastResult as Record<string, unknown>) : {};
  return {
    ...base,
    matched: false,
    chapterIndex: undefined,
    chapterTitle: undefined,
    detectedChapterNumber: undefined,
    attemptLimitReached: true,
    attemptedQueries,
    notice:
      "未能可靠定位章节，请补充更准确的章节名",
    reason:
      "Chapter lookup attempt limit reached. Stop chapter search in this turn and ask the user for a more accurate chapter title.",
  };
}

// --- Stream Event Types ---

export type AgentStreamEvent =
  | { type: "token"; content: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | {
      type: "reasoning";
      content: string;
      stepType: "thinking" | "planning" | "analyzing" | "deciding";
    }
  | {
      type: "citation";
      citation: {
        id: string;
        bookId: string;
        chapterTitle: string;
        chapterIndex: number;
        cfi: string;
        text: string;
        citationIndex?: number;
      };
    }
  | { type: "error"; error: string };

export interface ReadingAgentOptions {
  aiConfig: AIConfig;
  book: Book | null;
  bookId?: string | null;
  semanticContext: SemanticContext | null;
  enabledSkills: Skill[];
  isVectorized: boolean;
  deepThinking?: boolean;
  spoilerFree?: boolean;
  memorySummary?: string;
  /** Injected tool provider — returns available tools for the agent */
  getAvailableTools: (options: {
    bookId: string | null;
    isVectorized: boolean;
    enabledSkills: Skill[];
  }) => ToolDefinition[];
  /** Abort signal for immediate cancellation */
  signal?: AbortSignal;
}

// --- Build Zod schema from ToolDefinition.parameters ---

function buildZodSchema(
  parameters: Record<string, ToolParameter>,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, param] of Object.entries(parameters)) {
    let fieldSchema: z.ZodTypeAny;

    switch (param.type) {
      case "number":
        fieldSchema = z.number().describe(param.description);
        break;
      case "boolean":
        fieldSchema = z.boolean().describe(param.description);
        break;
      default:
        fieldSchema = z.string().describe(param.description);
        break;
    }

    if (!param.required) {
      fieldSchema = fieldSchema.optional();
    }

    shape[key] = fieldSchema;
  }

  return z.object(shape);
}

// --- Tool Executor (error-safe wrapper) ---

async function executeTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await tool.execute(args);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function selectToolsForInput(tools: ToolDefinition[], userInput: string): ToolDefinition[] {
  if (!CHAPTER_REFERENCE_RE.test(userInput)) return tools;
  const focused = tools.filter((tool) => CHAPTER_TASK_TOOL_NAMES.has(tool.name));
  return focused.length > 0 ? focused : tools;
}

// --- Main Agent Function ---

export async function* streamReadingAgent(
  options: ReadingAgentOptions,
  userInput: string,
  history: Array<{ role: "user" | "assistant"; content: string; reasoning?: string }> = [],
): AsyncGenerator<AgentStreamEvent> {
  const {
    aiConfig,
    book,
    bookId,
    semanticContext,
    enabledSkills,
    isVectorized,
    deepThinking,
    spoilerFree,
    memorySummary,
    getAvailableTools,
    signal,
  } = options;

  // Helper to check if aborted
  const isAborted = () => signal?.aborted ?? false;
  const chapterReferenceState = {
    executions: 0,
    totalChapterToolExecutions: 0,
    attemptedQueries: [] as string[],
    lastResult: null as unknown,
    limitReached: false,
  };
  const pendingToolCallNames: string[] = [];
  const isChapterTask = CHAPTER_REFERENCE_RE.test(userInput);

  try {
    // Early abort check
    if (isAborted()) return;

    // Create chat model
    const model = await createChatModel(aiConfig, {
      temperature: deepThinking ? 1 : 0.7,
      maxTokens: aiConfig.maxTokens,
      streaming: true,
      deepThinking,
    });

    // Check abort after async operation
    if (isAborted()) return;

    // Register tools via injected getAvailableTools, then narrow obvious chapter tasks.
    const effectiveBookId = book?.id || bookId || null;
    const tools = selectToolsForInput(
      getAvailableTools({
        bookId: effectiveBookId,
        isVectorized,
        enabledSkills,
      }),
      userInput,
    );

    // Build system prompt
    const systemPrompt = buildSystemPrompt({
      book,
      bookId: effectiveBookId,
      semanticContext,
      enabledSkills,
      isVectorized,
      userLanguage: i18n.language || "en",
      spoilerFree,
      memorySummary,
    });

    // Build input messages (history + user input, without system — handled by agent prompt)
    // For DeepSeek reasoner, we must include reasoning_content in assistant messages
    // to avoid 400 errors during multi-turn tool-calling conversations.
    const activeEndpoint = aiConfig.endpoints.find((e) => e.id === aiConfig.activeEndpointId);
    const isDeepSeek =
      activeEndpoint?.provider === "deepseek" ||
      activeEndpoint?.baseUrl?.includes("deepseek") ||
      aiConfig.activeModel?.toLowerCase().includes("deepseek") ||
      aiConfig.activeModel?.toLowerCase().includes("reasoner");

    const inputMessages: BaseMessage[] = [
      ...history.map((h) => {
        if (h.role === "user") {
          return new HumanMessage(h.content);
        }
        // For DeepSeek, include reasoning_content in additional_kwargs
        if (isDeepSeek && h.reasoning) {
          return new AIMessage({
            content: h.content,
            additional_kwargs: { reasoning_content: h.reasoning },
          });
        }
        return new AIMessage(h.content);
      }),
      new HumanMessage(userInput),
    ];

    // If no tools available, stream directly without agent graph
    if (tools.length === 0) {
      const { SystemMessage } = await import("@langchain/core/messages");
      const allMessages = [new SystemMessage(systemPrompt), ...inputMessages];
      const stream = await model.stream(allMessages);
      const thinkTagParser = new ThinkTagStreamParser();
      for await (const chunk of stream) {
        const content = chunk.content;
        if (typeof content === "string" && content) {
          for (const event of thinkTagParser.push(content)) {
            if (event.type === "token") {
              yield { type: "token", content: event.content };
            } else {
              yield { type: "reasoning", content: event.content, stepType: "thinking" };
            }
          }
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string" && block.text) {
              for (const event of thinkTagParser.push(block.text)) {
                if (event.type === "token") {
                  yield { type: "token", content: event.content };
                } else {
                  yield { type: "reasoning", content: event.content, stepType: "thinking" };
                }
              }
            } else if (block.type === "thinking") {
              const thinkingContent = [block.text, block.thinking, block.content].find(
                (value): value is string => typeof value === "string" && value.length > 0,
              );
              if (thinkingContent) {
                yield { type: "reasoning", content: thinkingContent, stepType: "thinking" };
              }
            }
          }
        }

        const reasoningContent = chunk.additional_kwargs?.reasoning_content;
        if (typeof reasoningContent === "string" && reasoningContent) {
          yield { type: "reasoning", content: reasoningContent, stepType: "thinking" };
        }
      }
      for (const event of thinkTagParser.flush()) {
        if (event.type === "token") {
          yield { type: "token", content: event.content };
        } else {
          yield { type: "reasoning", content: event.content, stepType: "thinking" };
        }
      }
      return;
    }

    // Build LangChain tools with proper Zod schemas
    const { DynamicStructuredTool } = await import("@langchain/core/tools");
    const langChainTools = tools.map((tool) => {
      const schema = buildZodSchema(tool.parameters);
      return new DynamicStructuredTool({
        name: tool.name,
        description: tool.description,
        schema,
        func: async (input) => {
          const toolInput = { ...(input as Record<string, unknown>) };
          const isChapterLookupTool = CHAPTER_LOOKUP_STOP_TOOL_NAMES.has(tool.name);

          if (chapterReferenceState.limitReached && isChapterLookupTool) {
            return JSON.stringify(
              buildChapterReferenceLimitResult(
                chapterReferenceState.lastResult,
                chapterReferenceState.attemptedQueries,
              ),
            );
          }

          if (isChapterTask && isChapterLookupTool) {
            if (chapterReferenceState.totalChapterToolExecutions >= CHAPTER_TOOL_EXECUTION_LIMIT) {
              chapterReferenceState.limitReached = true;
              return JSON.stringify(
                buildChapterReferenceLimitResult(
                  chapterReferenceState.lastResult,
                  chapterReferenceState.attemptedQueries,
                ),
              );
            }
            chapterReferenceState.totalChapterToolExecutions += 1;
          }

          if (tool.name === "resolveChapterReference") {
            if (chapterReferenceState.executions >= CHAPTER_REFERENCE_EXECUTION_LIMIT) {
              chapterReferenceState.limitReached = true;
              return JSON.stringify(
                buildChapterReferenceLimitResult(
                  chapterReferenceState.lastResult,
                  chapterReferenceState.attemptedQueries,
                ),
              );
            }

            const originalQuery = String(toolInput.query || userInput || "").trim();
            const effectiveQuery =
              chapterReferenceState.executions === 0
                ? originalQuery
                : chapterReferenceState.executions === 1
                  ? buildSecondAttemptChapterLookupQuery(originalQuery, userInput) || originalQuery
                  : simplifyChapterLookupQuery(originalQuery, userInput) || originalQuery;

            toolInput.query = effectiveQuery;
            chapterReferenceState.executions += 1;
            chapterReferenceState.attemptedQueries.push(effectiveQuery);
          }

          const result = await executeTool(tool, toolInput);
          if (tool.name === "resolveChapterReference") {
            chapterReferenceState.lastResult = result;
            if (
              chapterReferenceState.executions >= CHAPTER_REFERENCE_EXECUTION_LIMIT &&
              (!result ||
                typeof result !== "object" ||
                (result as Record<string, unknown>).matched !== true)
            ) {
              chapterReferenceState.limitReached = true;
            }
          }
          return JSON.stringify(result);
        },
      });
    });

    // Create LangGraph ReAct agent — handles tool-calling loop automatically
    const agent = createReactAgent({
      llm: model,
      tools: langChainTools,
      prompt: systemPrompt,
    });

    // Stream events from the agent graph.
    // Keep normal turns bounded; batch chapter tasks should use dedicated flows later.
    const eventStream = agent.streamEvents(
      { messages: inputMessages },
      {
        version: "v2",
        recursionLimit: isChapterTask ? CHAPTER_TASK_RECURSION_LIMIT : DEFAULT_RECURSION_LIMIT,
      },
    );

    // Track tool calls already emitted (from streaming chunks or on_chat_model_end)
    // so we can deduplicate against on_tool_start events.
    let pendingEarlyToolCalls = 0;

    // Accumulate tool_call_chunks from streaming to emit tool_call as early as possible.
    // Key: chunk index, Value: { name accumulated so far, args accumulated so far }
    const streamingToolCalls = new Map<number, { name: string; args: string; emitted: boolean }>();

    // Helper to race iterator next() against abort signal
    const raceNext = async (iterator: AsyncIterator<unknown>): Promise<IteratorResult<unknown>> => {
      if (isAborted()) {
        return { done: true, value: undefined };
      }
      const abortPromise = new Promise<IteratorResult<unknown>>((resolve) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ done: true, value: undefined });
        };
        signal?.addEventListener("abort", onAbort);
      });
      return Promise.race([iterator.next(), abortPromise]);
    };

    const iterator = eventStream[Symbol.asyncIterator]();
    let eventResult = await raceNext(iterator);
    let turnTextBuffer = "";

    function* flushBufferedTurnText(hasToolCalls: boolean): Generator<AgentStreamEvent> {
      if (!turnTextBuffer) return;
      const parser = new ThinkTagStreamParser();
      const events = [...parser.push(turnTextBuffer), ...parser.flush()];
      turnTextBuffer = "";
      for (const event of events) {
        if (event.type === "reasoning") {
          yield { type: "reasoning", content: event.content, stepType: "thinking" };
        } else if (hasToolCalls) {
          yield { type: "reasoning", content: event.content, stepType: "thinking" };
        } else {
          yield { type: "token", content: event.content };
        }
      }
    }

    while (!eventResult.done) {
      const event = eventResult.value as any;
      // Check for abort at each iteration
      if (isAborted()) return;

      // Token streaming from model
      if (event.event === "on_chat_model_stream") {
        const chunk = event.data?.chunk;
        if (chunk) {
          const content = chunk.content;

          // Buffer normal text until the model turn ends. If the same turn also
          // calls tools, that text is tool-planning chatter rather than final
          // answer text and must not be streamed into the response body.
          if (typeof content === "string" && content) {
            turnTextBuffer += content;
          } else if (Array.isArray(content)) {
            // Handle Anthropic-style content blocks (text + thinking)
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string" && block.text) {
                turnTextBuffer += block.text;
              } else if (block.type === "thinking") {
                // Anthropic may return thinking content in different fields
                // Try block.text first (most common), then block.thinking, then block.content
                const thinkingContent = [block.text, block.thinking, block.content].find(
                  (value): value is string => typeof value === "string" && value.length > 0,
                );
                if (thinkingContent) {
                  yield { type: "reasoning", content: thinkingContent, stepType: "thinking" };
                }
              }
            }
          }

          // Handle DeepSeek reasoning_content from @langchain/deepseek
          // ChatDeepSeek puts reasoning_content in additional_kwargs.reasoning_content
          const reasoningContent = chunk.additional_kwargs?.reasoning_content;
          if (typeof reasoningContent === "string" && reasoningContent) {
            yield { type: "reasoning", content: reasoningContent, stepType: "thinking" };
          }

          // Detect tool_call_chunks in streaming and emit tool_call as soon as we have the name.
          // This eliminates the delay between the last text token and on_chat_model_end.
          const toolCallChunks = chunk.tool_call_chunks;
          if (Array.isArray(toolCallChunks)) {
            for (const tcc of toolCallChunks) {
              const idx = tcc.index ?? 0;
              let entry = streamingToolCalls.get(idx);
              if (!entry) {
                entry = { name: "", args: "", emitted: false };
                streamingToolCalls.set(idx, entry);
              }
              if (tcc.name) entry.name += tcc.name;
              if (tcc.args) entry.args += tcc.args;

              // Emit as soon as we have a tool name (don't wait for full args)
              if (entry.name && !entry.emitted) {
                entry.emitted = true;
                pendingEarlyToolCalls++;
                yield {
                  type: "tool_call" as const,
                  name: entry.name,
                  args: {}, // args will arrive later; show pending UI immediately
                };
              }
            }
          }
        }
      }

      // When LLM finishes a turn, emit any tool_calls that weren't already
      // emitted from streaming chunks (e.g. non-OpenAI models that don't
      // send tool_call_chunks).
      if (event.event === "on_chat_model_end") {
        const output = event.data?.output;
        const toolCalls =
          output?.tool_calls ?? output?.additional_kwargs?.tool_calls ?? ([] as unknown[]);
        const hasToolCalls =
          (Array.isArray(toolCalls) && toolCalls.length > 0) ||
          [...streamingToolCalls.values()].some((entry) => entry.emitted);

        for (const flushedEvent of flushBufferedTurnText(hasToolCalls)) {
          yield flushedEvent;
        }

        // Clear streaming accumulator for the next LLM turn
        streamingToolCalls.clear();

        if (output) {
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              // Check if already emitted from streaming chunks
              if (pendingEarlyToolCalls > 0) {
                // Already emitted — skip but don't decrement yet (that's for on_tool_start)
                continue;
              }
              let args: Record<string, unknown>;
              try {
                args = (typeof tc.args === "string" ? JSON.parse(tc.args) : tc.args) as Record<
                  string,
                  unknown
                >;
              } catch {
                args = {};
              }
              pendingEarlyToolCalls++;
              yield {
                type: "tool_call" as const,
                name: tc.name,
                args,
              };
            }
          }
        }
      }

      // Tool call started — skip if already emitted earlier
      if (event.event === "on_tool_start") {
        pendingToolCallNames.push(event.name);
        if (pendingEarlyToolCalls > 0) {
          pendingEarlyToolCalls--;
        } else {
          // Fallback: emit if not already emitted (e.g. non-OpenAI model)
          yield {
            type: "tool_call",
            name: event.name,
            args: (event.data?.input as Record<string, unknown>) ?? {},
          };
        }
      }

      // Tool call completed
      if (event.event === "on_tool_end") {
        const pendingIndex = pendingToolCallNames.findIndex((name) => name === event.name);
        if (pendingIndex >= 0) pendingToolCallNames.splice(pendingIndex, 1);

        let result: unknown = event.data?.output;
        // ToolMessage objects need to have their content extracted
        const resultContent = (result as any)?.content ?? (result as any)?.lc_kwargs?.content;
        if (resultContent !== undefined) {
          result = resultContent;
        }
        try {
          if (typeof result === "string") result = JSON.parse(result);
        } catch {
          /* keep as string */
        }

        // Emit citation event for addCitation tool results
        if (event.name === "addCitation" && result && typeof result === "object") {
          const citationData = result as Record<string, unknown>;
          if (citationData.type === "citation") {
            yield {
              type: "citation",
              citation: {
                id: `citation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                bookId: citationData.bookId as string,
                chapterTitle: citationData.chapterTitle as string,
                chapterIndex: citationData.chapterIndex as number,
                cfi: citationData.cfi as string,
                text: citationData.text as string,
                citationIndex: citationData.citationIndex as number | undefined,
              },
            };
          }
        }

        yield { type: "tool_result", name: event.name, result };
      }

      // Get next event
      eventResult = await raceNext(iterator);
    }
  } catch (error) {
    console.error("[ReadingAgent] Error:", error);
    if (error instanceof Error) {
      console.error("[ReadingAgent] Stack:", error.stack);
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isRecursionError = /Recursion limit/i.test(errorMessage);
    if (isChapterTask && (chapterReferenceState.limitReached || isRecursionError)) {
      const limitResult = buildChapterReferenceLimitResult(
        chapterReferenceState.lastResult,
        chapterReferenceState.attemptedQueries,
      );
      const uniquePendingNames = Array.from(new Set(pendingToolCallNames)).filter((name) =>
        CHAPTER_LOOKUP_STOP_TOOL_NAMES.has(name),
      );
      for (const name of uniquePendingNames) {
        yield { type: "tool_result", name, result: limitResult };
      }
      yield {
        type: "token",
        content: "未能可靠定位章节，请补充更准确的章节名",
      };
      return;
    }
    yield { type: "error", error: errorMessage };
  }
}

// --- Legacy exports for compatibility ---

export { buildSystemPrompt };
