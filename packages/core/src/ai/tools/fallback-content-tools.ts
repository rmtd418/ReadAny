import { estimateTokens } from "../../rag/chunker";
import type { FallbackChapter } from "../fallback-content-service";
import {
  buildFallbackSnippet,
  findFallbackSegmentByTerms,
  getFallbackChaptersForBook,
} from "../fallback-source-resolver";
import type { ToolDefinition } from "./tool-types";

const SEARCH_TOKEN_BUDGET = 3600;
const CHAPTER_TOKEN_BUDGET = 3200;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreChapter(chapter: FallbackChapter, terms: string[]): number {
  const haystack = normalize(`${chapter.title}\n${chapter.content}`);
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = haystack.match(new RegExp(escaped, "g"));
    score += matches?.length ?? 0;
  }
  return score;
}

function findSnippet(chapter: FallbackChapter, terms: string[]): string {
  const content = chapter.content.replace(/\s+/g, " ").trim();
  if (!content) return "";

  const lower = content.toLowerCase();
  const index = terms
    .map((term) => lower.indexOf(term))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (index ?? 0) - 320);
  return content.slice(start, start + 900);
}

export function createFallbackTocTool(bookId: string): ToolDefinition {
  return {
    name: "fallbackToc",
    description:
      "Get the table of contents by reading the original book file without vectorization. Use this for non-indexed books before exploring specific chapters.",
    parameters: {},
    execute: async () => {
      const data = await getFallbackChaptersForBook(bookId);
      if ("error" in data) return data;
      return {
        bookTitle: data.bookTitle,
        chapters: data.chapters.map((chapter) => ({
          index: chapter.index,
          title: chapter.title,
          preview: chapter.content.replace(/\s+/g, " ").trim().slice(0, 180),
        })),
        totalChapters: data.chapters.length,
        instruction:
          "Use fallbackChapterContext for a specific chapter, or fallbackSearch for keyword exploration.",
      };
    },
  };
}

export function createFallbackSearchTool(bookId: string): ToolDefinition {
  return {
    name: "fallbackSearch",
    description:
      "Keyword search the original book file without a vector index. Slower and less semantic than RAG, but useful when the book has not been vectorized. Returns a CFI only when the match can be mapped to a concrete reader text segment.",
    parameters: {
      query: { type: "string", description: "Keywords or phrase to search for", required: true },
      topK: { type: "number", description: "Number of chapters/snippets to return (default: 5)" },
    },
    execute: async (args) => {
      const data = await getFallbackChaptersForBook(bookId);
      if ("error" in data) return data;

      const query = String(args.query || "").trim();
      const topK = Math.max(1, Math.min(10, Number(args.topK) || 5));
      const terms = normalize(query)
        .split(/[\s,，。.!?;；:：、]+/)
        .filter(Boolean);
      if (terms.length === 0) return { error: "Query is empty" };

      const ranked = data.chapters
        .map((chapter) => ({ chapter, score: scoreChapter(chapter, terms) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      let totalTokens = 0;
      const results = [];
      for (const { chapter, score } of ranked) {
        const matchedSegment = findFallbackSegmentByTerms(chapter, terms);
        const snippet = matchedSegment
          ? buildFallbackSnippet(matchedSegment.text, terms)
          : findSnippet(chapter, terms);
        const tokens = estimateTokens(snippet);
        if (totalTokens + tokens > SEARCH_TOKEN_BUDGET) break;
        totalTokens += tokens;
        const result: {
          chapterTitle: string;
          chapterIndex: number;
          content: string;
          score: number;
          cfi?: string;
          cfiPrecision?: "segment";
        } = {
          chapterTitle: chapter.title,
          chapterIndex: chapter.index,
          content: snippet,
          score,
        };
        if (matchedSegment?.cfi) {
          result.cfi = matchedSegment.cfi;
          result.cfiPrecision = "segment";
        }
        results.push(result);
      }

      return {
        query,
        results,
        totalResults: ranked.length,
        returnedResults: results.length,
        totalTokens,
        tokenBudget: SEARCH_TOKEN_BUDGET,
        instruction:
          "These are keyword fallback results from the original file, not semantic vector results. If a result has a non-empty cfi, you may call addCitation with that exact cfi and quotedText. If no cfi is present, cite chapterTitle/chapterIndex in plain text.",
      };
    },
  };
}

export function createFallbackChapterContextTool(bookId: string): ToolDefinition {
  return {
    name: "fallbackChapterContext",
    description:
      "Read a chapter from the original book file without vectorization. Use it after fallbackToc or when the user asks about a known chapter.",
    parameters: {
      chapterIndex: {
        type: "number",
        description: "Chapter index from fallbackToc",
        required: true,
      },
    },
    execute: async (args) => {
      const data = await getFallbackChaptersForBook(bookId);
      if ("error" in data) return data;

      const chapterIndex = Number(args.chapterIndex);
      const chapter = data.chapters.find((item) => item.index === chapterIndex);
      if (!chapter) return { error: `Chapter ${chapterIndex} not found` };

      const chunks: Array<{
        content: string;
        chapterTitle: string;
        chapterIndex: number;
        cfi?: string;
        cfiPrecision?: "segment";
      }> = [];
      let totalTokens = 0;

      for (const segment of chapter.segments ?? []) {
        const text = segment.text?.trim();
        if (!text) continue;
        const tokens = estimateTokens(text);
        const shouldTruncateFirstSegment = chunks.length === 0 && tokens > CHAPTER_TOKEN_BUDGET;
        if (!shouldTruncateFirstSegment && totalTokens + tokens > CHAPTER_TOKEN_BUDGET) break;
        const content = shouldTruncateFirstSegment ? text.slice(0, CHAPTER_TOKEN_BUDGET * 4) : text;
        totalTokens += Math.min(tokens, CHAPTER_TOKEN_BUDGET);
        const chunk: {
          content: string;
          chapterTitle: string;
          chapterIndex: number;
          cfi?: string;
          cfiPrecision?: "segment";
        } = {
          content,
          chapterTitle: chapter.title,
          chapterIndex: chapter.index,
        };
        if (segment.cfi) {
          chunk.cfi = segment.cfi;
          chunk.cfiPrecision = "segment";
        }
        chunks.push(chunk);
        if (shouldTruncateFirstSegment) break;
      }

      if (chunks.length === 0) {
        const tokens = estimateTokens(chapter.content);
        const content =
          tokens > CHAPTER_TOKEN_BUDGET
            ? chapter.content.slice(0, CHAPTER_TOKEN_BUDGET * 4)
            : chapter.content;
        totalTokens = Math.min(tokens, CHAPTER_TOKEN_BUDGET);
        chunks.push({
          content,
          chapterTitle: chapter.title,
          chapterIndex: chapter.index,
        });
      }

      const content = chunks.map((chunk) => chunk.content).join("\n\n");

      return {
        chapterTitle: chapter.title,
        chapterIndex: chapter.index,
        content,
        chunks,
        totalTokens,
        tokenBudget: CHAPTER_TOKEN_BUDGET,
        truncated: estimateTokens(chapter.content) > totalTokens,
        instruction:
          "Summarize or analyze this chapter using only the returned content. If the specific chunk you cite has a non-empty cfi, you may call addCitation with that exact cfi and quotedText. If no cfi is present, cite chapterTitle/chapterIndex in plain text.",
      };
    },
  };
}
