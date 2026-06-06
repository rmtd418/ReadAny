import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { setFallbackContentProvider } from "@readany/core/ai";
import type { Book } from "@readany/core/types";
import { extractBookChapters } from "./book-extractor";

export function registerDesktopFallbackContentProvider(): void {
  setFallbackContentProvider({
    async getChapters(book: Book) {
      const filePath = await resolveDesktopDataPath(book.filePath);
      return extractBookChapters(filePath);
    },
  });
}
