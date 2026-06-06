import { getPlatformService } from "@readany/core/services";
import type { Book } from "@readany/core/types";
import { queueBook as queueAutoVectorize } from "./auto-vectorize-service";

const MOBILE_AUTO_VECTORIZER_MAX_BYTES = 12 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.ebook",
  cbz: "application/vnd.comicbook+zip",
  cbr: "application/vnd.comicbook+zip",
  fb2: "application/x-fictionbook+xml",
  fbz: "application/x-zip-compressed-fb2",
  txt: "text/plain",
  umd: "application/octet-stream",
};

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function resolveBookPath(filePath: string): Promise<string> {
  if (
    filePath.startsWith("/") ||
    filePath.startsWith("file://") ||
    filePath.startsWith("asset://") ||
    filePath.startsWith("http")
  ) {
    return filePath;
  }

  const platform = getPlatformService();
  const appData = await platform.getAppDataDir();
  return platform.joinPath(appData, filePath);
}

export async function queueBookForAutoVectorize(book: Book): Promise<boolean> {
  const platform = getPlatformService();
  const absPath = await resolveBookPath(book.filePath);
  const bytes = await platform.readFile(absPath);

  if (bytes.byteLength > MOBILE_AUTO_VECTORIZER_MAX_BYTES) {
    console.warn(
      `[AutoVectorize] Skip large synced download: ${book.meta.title} (${bytes.byteLength} bytes)`,
    );
    return false;
  }

  const format = String(book.format || "").toLowerCase();
  queueAutoVectorize(book, bytesToBase64(bytes), MIME_TYPES[format] || "application/epub+zip");
  return true;
}
