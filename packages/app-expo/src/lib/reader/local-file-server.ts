/**
 * Native local HTTP file server for serving book files to the WebView.
 *
 * Tries @dr.pogodin/react-native-static-server (embedded Lighttpd) first:
 * - Serves files directly from the native layer (no JS bridge overhead)
 * - Supports HTTP Range requests (206 Partial Content) out of the box
 * - Enables foliate-js to lazily read ZIP entries without loading the entire file
 *
 * Falls back to react-native-tcp-socket JS-layer server if the native static
 * server module is not available (e.g. during development without a rebuild).
 */
import { File } from "expo-file-system";

// --- State ---
let _nativeServer: any | null = null;
let _tcpServer: any | null = null;
let _serverUrl: string | null = null;
let _serverDocRoot: string | null = null;
let _useNative: boolean | null = null; // null = not yet determined

/**
 * Start a local file server serving files from `docRoot`.
 * Returns the base URL (e.g. `http://127.0.0.1:12345`).
 * Reuses the existing server if one is already running for the same docRoot.
 */
export async function startFileServer(docRoot: string): Promise<string> {
  // Strip file:// URI prefix — native servers need plain filesystem paths
  let cleanRoot = docRoot.replace(/\/+$/, "");
  if (cleanRoot.startsWith("file://")) {
    cleanRoot = decodeURIComponent(cleanRoot.slice(7));
  }

  // Reuse existing server
  if (_serverUrl && _serverDocRoot === cleanRoot) {
    // Check if native server is still active
    if (_nativeServer) {
      try {
        const { STATES } = await import("@dr.pogodin/react-native-static-server");
        if (_nativeServer.state === STATES.ACTIVE) return _serverUrl;
      } catch {}
    }
    if (_tcpServer) return _serverUrl;
  }

  // Stop existing
  await stopFileServer();

  // Determine which backend to use (once)
  if (_useNative === null) {
    try {
      await import("@dr.pogodin/react-native-static-server");
      _useNative = true;
    } catch {
      _useNative = false;
    }
  }

  if (_useNative) {
    return _startNativeServer(cleanRoot);
  }
  return _startTcpFallback(cleanRoot);
}

// --- Native Lighttpd server ---
async function _startNativeServer(cleanRoot: string): Promise<string> {
  let server: any = null;
  try {
    const StaticServerModule = await import("@dr.pogodin/react-native-static-server");
    const StaticServer = StaticServerModule.default;

    server = new StaticServer({
      fileDir: cleanRoot,
      port: 0,
      stopInBackground: false,
    });
    // Cap server.start() so a hung Lighttpd init can't pin the reader on a spinner.
    // On timeout we treat it the same as a throw: stop and fall back to TCP below.
    const origin = await Promise.race([
      server.start(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Lighttpd startup timeout (3s)")), 3000),
      ),
    ]);
    _nativeServer = server;
    _serverDocRoot = cleanRoot;
    _serverUrl = origin;
    console.log(`[FileServer] Native Lighttpd started: ${origin} (root: ${cleanRoot})`);
    return origin;
  } catch (e) {
    // Native module unavailable at runtime (e.g. peer dep @dr.pogodin/react-native-fs
    // not linked into the native binary). Drop down to the JS TCP fallback so reading
    // still works without rebuilding the dev client.
    console.warn(
      `[FileServer] Native Lighttpd unavailable (${e instanceof Error ? e.message : e}), falling back to TCP`,
    );
    if (server) {
      try { await server.stop?.(); } catch {}
    }
    _nativeServer = null;
    _useNative = false;
    return _startTcpFallback(cleanRoot);
  }
}

// --- Fallback: JS TCP server (original implementation) ---
async function _startTcpFallback(cleanRoot: string): Promise<string> {
  // TCP fallback also needs plain path
  let fsRoot = cleanRoot;
  if (fsRoot.startsWith("file://")) {
    fsRoot = decodeURIComponent(fsRoot.slice(7));
  }

  let TcpSocket: any;
  try {
    TcpSocket = (await import("react-native-tcp-socket")).default;
    console.log("[FileServer] TCP socket module loaded, starting server...");
  } catch (e) {
    throw new Error(`No file server available: ${e instanceof Error ? e.message : e}`);
  }

  return new Promise<string>((resolve, reject) => {
    // Safety timeout: if the TCP server can't bind within 5s, bail out
    const tcpTimeout = setTimeout(() => {
      reject(new Error("TCP server startup timeout (5s)"));
    }, 5000);

    const server = TcpSocket.createServer((socket: any) => {
      let headerBuf = "";

      socket.on("data", async (data: any) => {
        headerBuf += data.toString();

        const headerEnd = headerBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const requestLine = headerBuf.slice(0, headerBuf.indexOf("\r\n"));
        const [, rawPath] = requestLine.split(" ") || [];

        if (!rawPath || rawPath === "/favicon.ico") {
          socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
          socket.destroy();
          return;
        }

        const decodedPath = decodeURIComponent(rawPath.slice(1));
        if (decodedPath.includes("..")) {
          socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
          socket.destroy();
          return;
        }

        const filePath = `${fsRoot}/${decodedPath}`;
        let file: InstanceType<typeof File>;
        try {
          file = new File(filePath);
          if (!file.exists) {
            socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            socket.destroy();
            return;
          }
        } catch {
          socket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
          socket.destroy();
          return;
        }

        const size = file.size;
        const mime = _guessMime(filePath);

        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: ${mime}\r\nContent-Length: ${size}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n`,
        );

        let fileData: Uint8Array;
        try {
          fileData = await file.bytes();
        } catch {
          socket.destroy();
          return;
        }

        const CHUNK = 65536;
        let offset = 0;
        const pump = () => {
          if (offset >= fileData.length) {
            socket.destroy();
            return;
          }
          const end = Math.min(offset + CHUNK, fileData.length);
          const chunk = fileData.slice(offset, end);
          offset = end;
          try {
            socket.write(chunk, undefined, (err?: Error) => {
              if (err) { socket.destroy(); return; }
              pump();
            });
          } catch {
            socket.destroy();
          }
        };

        try { pump(); } catch { socket.destroy(); }
      });

      socket.on("error", () => socket.destroy());
    });

    server.on("error", (err: Error) => {
      clearTimeout(tcpTimeout);
      reject(err);
    });

    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      clearTimeout(tcpTimeout);
      const addr = server.address();
      const port = addr && typeof addr === "object" && "port" in addr ? addr.port : null;
      if (!port) {
        reject(new Error("Server address unavailable"));
        return;
      }
      const url = `http://127.0.0.1:${port}`;
      _tcpServer = server;
      _serverDocRoot = cleanRoot;
      _serverUrl = url;
      console.log(`[FileServer] TCP fallback started: ${url} (root: ${cleanRoot})`);
      resolve(url);
    });
  });
}

/**
 * Stop the file server.
 */
export async function stopFileServer(_docRoot?: string): Promise<void> {
  if (_nativeServer) {
    try { await _nativeServer.stop(); } catch {}
    _nativeServer = null;
  }
  if (_tcpServer) {
    try { _tcpServer.close(); } catch {}
    _tcpServer = null;
  }
  _serverUrl = null;
  _serverDocRoot = null;
}

// --- Helpers ---
const EXT_MIME: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw": "application/vnd.amazon.ebook",
  ".azw3": "application/vnd.amazon.ebook",
  ".cbz": "application/vnd.comicbook+zip",
  ".fb2": "application/x-fictionbook+xml",
  ".txt": "text/plain",
};

function _guessMime(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXT_MIME[ext] || "application/octet-stream";
}
