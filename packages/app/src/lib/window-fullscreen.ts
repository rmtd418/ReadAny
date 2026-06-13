import type { Window as TauriWindow } from "@tauri-apps/api/window";
import {
  StateFlags,
  restoreStateCurrent,
  saveWindowState,
} from "@tauri-apps/plugin-window-state";

type WindowedBounds = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

const WINDOW_STATE_SETTLE_MS = 40;
const FULLSCREEN_TRANSITION_MASK_HOLD_MS = 140;
const FULLSCREEN_RESTORE_STATE_KEY = "readany:restore-window-state-after-fullscreen";

const FULLSCREEN_SNAPSHOT_FLAGS =
  StateFlags.MAXIMIZED | StateFlags.POSITION | StateFlags.SIZE;

const rememberedWindowedBounds = new Map<string, WindowedBounds>();

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const waitForWindowState = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

const waitForWindowFrame = () => waitForWindowState(16);

const getWindowKey = (appWindow: TauriWindow) => appWindow.label;

const readWindowedBounds = async (appWindow: TauriWindow) => {
  const [position, size] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.outerSize(),
  ]);

  return {
    position: { x: position.x, y: position.y },
    size: { width: size.width, height: size.height },
  } satisfies WindowedBounds;
};

const createFullscreenTransitionMask = () => {
  if (typeof document === "undefined") return null;

  const mask = document.createElement("div");
  mask.setAttribute("data-readany-fullscreen-mask", "true");
  Object.assign(mask.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    background: "var(--background, #111111)",
    opacity: "1",
    pointerEvents: "none",
  });
  document.body.append(mask);
  return mask;
};

const removeFullscreenTransitionMask = (mask: HTMLDivElement | null) => {
  mask?.remove();
};

const setRestoreWindowStateFlag = (value: boolean) => {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(FULLSCREEN_RESTORE_STATE_KEY, value ? "1" : "0");
};

const consumeRestoreWindowStateFlag = () => {
  if (typeof window === "undefined") return false;
  const value = window.sessionStorage.getItem(FULLSCREEN_RESTORE_STATE_KEY) === "1";
  window.sessionStorage.removeItem(FULLSCREEN_RESTORE_STATE_KEY);
  return value;
};

const waitForFullscreenState = async (appWindow: TauriWindow, target: boolean) => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await appWindow.isFullscreen()) === target) return true;
    await waitForWindowState(WINDOW_STATE_SETTLE_MS);
  }
  return (await appWindow.isFullscreen()) === target;
};

export async function rememberWindowedBounds(appWindow: TauriWindow): Promise<void> {
  const [fullscreen, maximized] = await Promise.all([
    appWindow.isFullscreen(),
    appWindow.isMaximized(),
  ]);
  if (fullscreen || maximized) return;

  rememberedWindowedBounds.set(getWindowKey(appWindow), await readWindowedBounds(appWindow));
}

export async function toggleWindowFullscreen(appWindow: TauriWindow): Promise<void> {
  const [fullscreen, maximized] = await Promise.all([
    appWindow.isFullscreen(),
    appWindow.isMaximized(),
  ]);

  if (fullscreen) {
    await appWindow.setFullscreen(false);
    if (consumeRestoreWindowStateFlag()) {
      await waitForFullscreenState(appWindow, false);
      await restoreStateCurrent(FULLSCREEN_SNAPSHOT_FLAGS);
    }
    return;
  }

  await saveWindowState(FULLSCREEN_SNAPSHOT_FLAGS);
  setRestoreWindowStateFlag(true);
  const transitionMask = maximized ? createFullscreenTransitionMask() : null;

  if (maximized) {
    try {
      // Let the mask paint before the native window starts resizing.
      await waitForWindowState(0);
      await appWindow.unmaximize();
      await waitForWindowState(WINDOW_STATE_SETTLE_MS);
      await appWindow.setFullscreen(true);
      await waitForWindowState(FULLSCREEN_TRANSITION_MASK_HOLD_MS);
    } finally {
      removeFullscreenTransitionMask(transitionMask);
    }
    return;
  }

  await appWindow.setFullscreen(true);
}

export async function exitWindowFullscreen(appWindow: TauriWindow): Promise<void> {
  if (await appWindow.isFullscreen()) {
    await toggleWindowFullscreen(appWindow);
  }
}

export async function startDraggingFromWindowFullscreen(
  appWindow: TauriWindow,
  clientX: number,
  clientY: number,
  headerRect: DOMRect,
): Promise<void> {
  const {
    PhysicalPosition,
    PhysicalSize,
    cursorPosition,
    monitorFromPoint,
  } = await import("@tauri-apps/api/window");

  const cursor = await cursorPosition();
  const monitor = await monitorFromPoint(cursor.x, cursor.y);
  const fallbackWidth = monitor ? Math.round(Math.min(monitor.workArea.size.width * 0.78, 1600)) : 1280;
  const fallbackHeight = monitor ? Math.round(Math.min(monitor.workArea.size.height * 0.82, 1000)) : 820;
  const targetBounds = rememberedWindowedBounds.get(getWindowKey(appWindow)) ?? {
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
  consumeRestoreWindowStateFlag();
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

  rememberedWindowedBounds.set(getWindowKey(appWindow), {
    position: { x: Math.round(nextX), y: Math.round(nextY) },
    size: { width: targetWidth, height: targetHeight },
  });

  await waitForWindowFrame();
  await appWindow.startDragging();
}
