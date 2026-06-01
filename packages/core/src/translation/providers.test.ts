import { describe, expect, it } from "vitest";
import { buildAITranslationPrompt } from "./providers";

describe("buildAITranslationPrompt", () => {
  it("asks AI to translate classical Chinese into modern vernacular Chinese", () => {
    const prompt = buildAITranslationPrompt("AUTO", "zh-CN");

    expect(prompt).toContain("Classical/Literary Chinese");
    expect(prompt).toContain("modern vernacular Simplified Chinese");
    expect(prompt).toContain("学而不思则罔，思而不学则殆");
    expect(prompt).toContain("not the original sentence");
    expect(prompt).toContain("Do not mention source, author, title");
    expect(prompt).toContain("most likely modern meaning in context");
  });

  it("keeps numbered output requirements for batch translation", () => {
    const prompt = buildAITranslationPrompt("AUTO", "zh-CN", { numbered: true });

    expect(prompt).toContain('keep the same numbering format "N. translation"');
    expect(prompt).toContain("Do not add any explanation");
  });
});
