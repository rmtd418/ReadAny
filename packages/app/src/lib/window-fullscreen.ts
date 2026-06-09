import type { Window as TauriWindow } from "@tauri-apps/api/window";

const WINDOW_STATE_SETTLE_MS = 40;
const FULLSCREEN_TRANSITION_MASK_HOLD_MS = 140;
const FULLSCREEN_RESTORE_MAXIMIZED_KEY = "readany:restore-maximized-after-fullscreen";
const FULLSCREEN_EXIT_RESTORE_ATTEMPTS = 6;

const waitForWindowState = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

const waitForFullscreenState = async (appWindow: TauriWindow, target: boolean) => {
  for (let attempt = 0; attempt < FULLSCREEN_EXIT_RESTORE_ATTEMPTS; attempt += 1) {
    if ((await appWindow.isFullscreen()) === target) return true;
    await waitForWindowState(WINDOW_STATE_SETTLE_MS);
  }
  return (await appWindow.isFullscreen()) === target;
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

const setRestoreMaximizedFlag = (value: boolean) => {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(FULLSCREEN_RESTORE_MAXIMIZED_KEY, value ? "1" : "0");
};

const consumeRestoreMaximizedFlag = () => {
  if (typeof window === "undefined") return false;
  const value = window.sessionStorage.getItem(FULLSCREEN_RESTORE_MAXIMIZED_KEY) === "1";
  window.sessionStorage.removeItem(FULLSCREEN_RESTORE_MAXIMIZED_KEY);
  return value;
};

export async function toggleWindowFullscreen(appWindow: TauriWindow): Promise<void> {
  const [fullscreen, maximized] = await Promise.all([
    appWindow.isFullscreen(),
    appWindow.isMaximized(),
  ]);

  if (fullscreen) {
    await appWindow.setFullscreen(false);
    if (consumeRestoreMaximizedFlag()) {
      await waitForFullscreenState(appWindow, false);
      for (let attempt = 0; attempt < FULLSCREEN_EXIT_RESTORE_ATTEMPTS; attempt += 1) {
        await appWindow.maximize();
        await waitForWindowState(WINDOW_STATE_SETTLE_MS);
        if (await appWindow.isMaximized()) break;
      }
    }
    return;
  }

  setRestoreMaximizedFlag(maximized);
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
