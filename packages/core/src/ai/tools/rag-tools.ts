/**
 * RAG Tools — search, table of contents, and context retrieval
 */
import { getChunks } from "../../db/database";
import { estimateTokens } from "../../rag/chunker";
import { search } from "../../rag/search";
import type { SearchQuery } from "../../types";
import { resolveChapterReference } from "../chapter-reference-resolver";
import type { ToolDefinition } from "./tool-types";

const DEFAULT_TOC_LIMIT = 20;
const MAX_TOC_LIMIT = 60;

function clampLimit(value: unknown, fallback = DEFAULT_TOC_LIMIT): number {
  return Math.max(1, Math.min(MAX_TOC_LIMIT, Number(value) || fallback));
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** Create RAG search tool for a specific book */
export function createRagSearchTool(bookId: string): ToolDefinition {
  const MAX_TOTAL_TOKENS = 4000; // Token budget for all results combined
  const MIN_CONTENT_TOKENS = 100; // Minimum tokens per result

  return {
    name: "ragSearch",
    description:
      "Search book content using semantic or keyword search. Returns results with 'cfi' field for precise location. CRITICAL: When you cite content from search results, you MUST extract and pass the 'cfi' field to addCitation - this enables users to jump to the exact location in the book.",
    parameters: {
      query: {
        type: "string",
        description: "The search query describing what to find",
        required: true,
      },
      mode: {
        type: "string",
        description:
          'Search mode: "hybrid" (recommended), "vector" (semantic), or "bm25" (keyword)',
      },
      topK: { type: "number", description: "Number of results to return (default: 5)" },
    },
    execute: async (args) => {
      const query: SearchQuery = {
        query: args.query as string,
        bookId,
        mode: (args.mode as "hybrid" | "vector" | "bm25") || "hybrid",
        topK: (args.topK as number) || 5,
        threshold: 0.3,
      };

      const results = await search(query);

      // Smart truncation with token budget
      let totalTokens = 0;
      const truncatedResults = [];

      for (const r of results) {
        const fullContent = r.chunk.content;
        const fullTokens = estimateTokens(fullContent);

        // Calculate remaining budget
        const remainingBudget = MAX_TOTAL_TOKENS - totalTokens;

        if (remainingBudget <= MIN_CONTENT_TOKENS) {
          // Budget exhausted, stop adding results
          break;
        }

        let content = fullContent;
        let contentTokens = fullTokens;

        // Truncate if exceeds remaining budget
        if (contentTokens > remainingBudget) {
          // Estimate character limit based on remaining tokens
          const charLimit = remainingBudget * 4; // ~4 chars per token
          content = fullContent.slice(0, charLimit);
          contentTokens = estimateTokens(content);
        }

        totalTokens += contentTokens;

        truncatedResults.push({
          chapter: r.chunk.chapterTitle,
          chapterIndex: r.chunk.chapterIndex,
          content,
          score: Math.round(r.score * 1000) / 1000,
          matchType: r.matchType,
          highlights: r.highlights,
          cfi: r.chunk.startCfi || "",
          truncated: fullTokens > contentTokens,
        });
      }

      return {
        results: truncatedResults,
        totalResults: results.length,
        returnedResults: truncatedResults.length,
        totalTokens,
        tokenBudget: MAX_TOTAL_TOKENS,
      };
    },
  };
}

/** Create RAG TOC tool for a specific book */
export function createRagTocTool(bookId: string): ToolDefinition {
  return {
    name: "ragToc",
    description:
      "Get a compact, limited chapter list. Use query/aroundChapter/offset/limit instead of loading the full table of contents.",
    parameters: {
      query: {
        type: "string",
        description: "Optional chapter title or chapter number text to search for",
      },
      aroundChapter: {
        type: "number",
        description: "Optional chapter index to return nearby chapters around",
      },
      offset: {
        type: "number",
        description: "Pagination offset when browsing the chapter list",
      },
      limit: {
        type: "number",
        description: "Maximum chapters to return (default 20, max 60)",
      },
    },
    execute: async (args) => {
      // Get unique chapter titles from chunks
      const chunks = await getChunks(bookId);
      const chapters = new Map<number, string>();
      for (const chunk of chunks) {
        if (!chapters.has(chunk.chapterIndex)) {
          chapters.set(chunk.chapterIndex, chunk.chapterTitle);
        }
      }
      let chapterList = Array.from(chapters.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([index, title]) => ({ index, title }));

      const query = String(args.query || "").trim();
      const aroundChapter =
        typeof args.aroundChapter === "number" ? Number(args.aroundChapter) : undefined;
      const limit = clampLimit(args.limit);
      let offset = Math.max(0, Number(args.offset) || 0);

      if (query) {
        const normalized = normalizeQuery(query);
        chapterList = chapterList.filter((chapter) =>
          normalizeQuery(`${chapter.index + 1}${chapter.title}`).includes(normalized),
        );
        offset = 0;
      } else if (aroundChapter !== undefined && Number.isFinite(aroundChapter)) {
        const half = Math.floor(limit / 2);
        const aroundIndex = chapterList.findIndex((c) => c.index >= aroundChapter);
        offset =
          aroundIndex >= 0
            ? Math.max(0, aroundIndex - half)
            : Math.max(0, chapterList.length - limit);
      }

      const pagedChapters = chapterList.slice(offset, offset + limit);

      return {
        chapters: pagedChapters,
        totalChapters: chapters.size,
        matchedChapters: chapterList.length,
        returned: pagedChapters.length,
        offset,
        limit,
        hasMore: offset + pagedChapters.length < chapterList.length,
        nextOffset:
          offset + pagedChapters.length < chapterList.length
            ? offset + pagedChapters.length
            : undefined,
        instruction:
          "This is a compact chapter list. Use resolveChapterReference for user-provided chapter numbers or fuzzy chapter titles.",
      };
    },
  };
}

export function createResolveChapterReferenceTool(bookId: string): ToolDefinition {
  return {
    name: "resolveChapterReference",
    description:
      "Resolve a user-mentioned chapter number or fuzzy chapter title to the internal chapterIndex. Use before ragContext/summarize when the user asks about a specific chapter.",
    parameters: {
      query: {
        type: "string",
        description: "The user's chapter reference, such as '245章' or a chapter title",
        required: true,
      },
      maxCandidates: {
        type: "number",
        description: "Maximum candidates to return when ambiguous (default 3)",
      },
    },
    execute: async (args) => {
      const chunks = await getChunks(bookId);
      const chapters = new Map<number, { title: string; preview: string }>();
      for (const chunk of chunks) {
        if (!chapters.has(chunk.chapterIndex)) {
          chapters.set(chunk.chapterIndex, {
            title: chunk.chapterTitle,
            preview: chunk.content.slice(0, 500),
          });
        }
      }

      const entries = Array.from(chapters.entries()).map(([chapterIndex, chapter]) => ({
        chapterIndex,
        chapterTitle: chapter.title,
        preview: chapter.preview,
      }));

      return resolveChapterReference(
        String(args.query || ""),
        entries,
        Number(args.maxCandidates) || 3,
      );
    },
  };
}

/** Create RAG context tool for a specific book */
export function createRagContextTool(bookId: string): ToolDefinition {
  const MAX_TOTAL_TOKENS = 3000;

  return {
    name: "ragContext",
    description:
      "Get surrounding text context for a specific chapter. Use this when the user asks about content near a specific location. Returns chunks with CFI information - use the CFI from the chunk containing your quoted text when calling addCitation.",
    parameters: {
      chapterIndex: { type: "number", description: "The chapter index", required: true },
      range: {
        type: "number",
        description: "Number of chunks to include before and after (default: 2)",
      },
    },
    execute: async (args) => {
      const chapterIndex = args.chapterIndex as number;
      const range = (args.range as number) || 2;

      const chunks = await getChunks(bookId);
      const chapterChunks = chunks.filter((c) => c.chapterIndex === chapterIndex);

      // Get surrounding chunks with token budget
      const sourceRefs: Array<{ id: string; excerpt: string; cfi: string }> = [];
      const contextParts: string[] = [];
      let totalTokens = 0;

      for (const c of chapterChunks.slice(0, range * 2 + 1)) {
        const chunkTokens = estimateTokens(c.content);
        if (totalTokens + chunkTokens > MAX_TOTAL_TOKENS) {
          // Truncate to fit budget
          const remaining = MAX_TOTAL_TOKENS - totalTokens;
          if (remaining > 100) {
            const charLimit = remaining * 4;
            const content = c.content.slice(0, charLimit);
            contextParts.push(content);
            sourceRefs.push({
              id: c.id,
              excerpt: content.slice(0, 180),
              cfi: c.startCfi || "",
            });
          }
          break;
        }
        contextParts.push(c.content);
        sourceRefs.push({
          id: c.id,
          excerpt: c.content.slice(0, 180),
          cfi: c.startCfi || "",
        });
        totalTokens += chunkTokens;
      }

      return {
        chapterTitle: chapterChunks[0]?.chapterTitle || "Unknown",
        chapterIndex: chapterIndex,
        context: contextParts.join("\n\n"),
        sourceRefs,
        chunksIncluded: contextParts.length,
        totalTokens,
        tokenBudget: MAX_TOTAL_TOKENS,
      };
    },
  };
}
