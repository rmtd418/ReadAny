import type { Window as TauriWindow } from "@tauri-apps/api/window";

type WindowedBounds = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

type FullscreenRestoreState = {
  restoreMode: "windowed" | "maximized";
  windowedBounds: WindowedBounds | null;
};

const fullscreenRestoreStates = new Map<string, FullscreenRestoreState>();
const rememberedWindowedBounds = new Map<string, WindowedBounds>();

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const waitForWindowFrame = () => new Promise((resolve) => window.setTimeout(resolve, 16));

function getWindowKey(appWindow: TauriWindow) {
  return appWindow.label;
}

async function readWindowedBounds(appWindow: TauriWindow) {
  const [position, size] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.outerSize(),
  ]);

  return {
    position: { x: position.x, y: position.y },
    size: { width: size.width, height: size.height },
  } satisfies WindowedBounds;
}

export async function rememberWindowedBounds(appWindow: TauriWindow) {
  const [fullscreen, maximized] = await Promise.all([
    appWindow.isFullscreen(),
    appWindow.isMaximized(),
  ]);
  if (fullscreen || maximized) return;

  rememberedWindowedBounds.set(getWindowKey(appWindow), await readWindowedBounds(appWindow));
}

export async function enterManagedFullscreen(appWindow: TauriWindow) {
  if (await appWindow.isFullscreen()) return;

  const key = getWindowKey(appWindow);
  const maximized = await appWindow.isMaximized();
  const windowedBounds = maximized
    ? (rememberedWindowedBounds.get(key) ?? null)
    : await readWindowedBounds(appWindow);

  if (windowedBounds) {
    rememberedWindowedBounds.set(key, windowedBounds);
  }

  fullscreenRestoreStates.set(key, {
    restoreMode: maximized ? "maximized" : "windowed",
    windowedBounds,
  });

  if (maximized) {
    await appWindow.unmaximize();
  }

  await appWindow.setFullscreen(true);
}

export async function exitManagedFullscreen(appWindow: TauriWindow) {
  const key = getWindowKey(appWindow);
  const restoreState = fullscreenRestoreStates.get(key) ?? null;

  if (!(await appWindow.isFullscreen())) return;

  await appWindow.setFullscreen(false);
  await waitForWindowFrame();

  if (restoreState?.restoreMode === "maximized") {
    await appWindow.maximize();
    fullscreenRestoreStates.delete(key);
    return;
  }

  if (await appWindow.isMaximized()) {
    await appWindow.unmaximize();
    await waitForWindowFrame();
  }

  const windowedBounds = restoreState?.windowedBounds ?? rememberedWindowedBounds.get(key) ?? null;
  if (windowedBounds) {
    const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/window");
    await appWindow.setSize(new PhysicalSize(windowedBounds.size.width, windowedBounds.size.height));
    await appWindow.setPosition(
      new PhysicalPosition(windowedBounds.position.x, windowedBounds.position.y),
    );
    rememberedWindowedBounds.set(key, windowedBounds);
  }

  fullscreenRestoreStates.delete(key);
}

export async function toggleManagedFullscreen(appWindow: TauriWindow) {
  if (await appWindow.isFullscreen()) {
    await exitManagedFullscreen(appWindow);
    return;
  }

  await enterManagedFullscreen(appWindow);
}

export async function startDraggingFromManagedFullscreen(
  appWindow: TauriWindow,
  clientX: number,
  clientY: number,
  headerRect: DOMRect,
) {
  const {
    PhysicalPosition,
    PhysicalSize,
    cursorPosition,
    monitorFromPoint,
  } = await import("@tauri-apps/api/window");

  const key = getWindowKey(appWindow);
  const restoreState = fullscreenRestoreStates.get(key) ?? null;
  const cursor = await cursorPosition();
  const monitor = await monitorFromPoint(cursor.x, cursor.y);
  const fallbackWidth = monitor ? Math.round(Math.min(monitor.workArea.size.width * 0.78, 1600)) : 1280;
  const fallbackHeight = monitor ? Math.round(Math.min(monitor.workArea.size.height * 0.82, 1000)) : 820;
  const targetBounds = restoreState?.windowedBounds
    ?? rememberedWindowedBounds.get(key)
    ?? {
      position: { x: cursor.x, y: cursor.y },
      size: { width: fallbackWidth, height: fallbackHeight },
    };
  const targetWidth = monitor
    ? Math.min(targetBounds.size.width, monitor.workArea.size.width)
    : targetBounds.size.width;
  const targetHeight = monitor
    ? Math.min(targetBounds.size.height, monitor.workArea.size.height)
    : targetBounds.size.height;
  const anchorRatio = headerRect.width > 0
    ? clamp((clientX - headerRect.left) / headerRect.width, 0, 1)
    : 0.5;
  const headerOffsetY = clamp(clientY - headerRect.top, 12, 36);

  await appWindow.setFullscreen(false);
  await waitForWindowFrame();

  if (await appWindow.isMaximized()) {
    await appWindow.unmaximize();
    await waitForWindowFrame();
  }

  let nextX = cursor.x - targetWidth * anchorRatio;
  let nextY = cursor.y - headerOffsetY;

  if (monitor) {
    const minX = monitor.workArea.position.x;
    const maxX = monitor.workArea.position.x + monitor.workArea.size.width - targetWidth;
    const minY = monitor.workArea.position.y;
    const maxY = monitor.workArea.position.y + monitor.workArea.size.height - Math.min(targetHeight, 96);
    nextX = clamp(nextX, minX, Math.max(minX, maxX));
    nextY = clamp(nextY, minY, Math.max(minY, maxY));
  }

  await appWindow.setSize(new PhysicalSize(targetWidth, targetHeight));
  await appWindow.setPosition(new PhysicalPosition(Math.round(nextX), Math.round(nextY)));

  const nextBounds = {
    position: { x: Math.round(nextX), y: Math.round(nextY) },
    size: { width: targetWidth, height: targetHeight },
  } satisfies WindowedBounds;
  rememberedWindowedBounds.set(key, nextBounds);
  fullscreenRestoreStates.delete(key);

  await waitForWindowFrame();
  await appWindow.startDragging();
}
