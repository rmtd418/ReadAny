import type { Window as TauriWindow } from "@tauri-apps/api/window";

const WINDOW_STATE_SETTLE_MS = 40;

const waitForWindowState = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

export async function toggleWindowFullscreen(appWindow: TauriWindow): Promise<void> {
  const [fullscreen, maximized] = await Promise.all([
    appWindow.isFullscreen(),
    appWindow.isMaximized(),
  ]);

  if (fullscreen) {
    await appWindow.setFullscreen(false);
    return;
  }

  // Try entering true fullscreen directly first. On Windows this avoids the
  // visible "restore -> expand" jitter when the window is already maximized.
  await appWindow.setFullscreen(true);
  await waitForWindowState(WINDOW_STATE_SETTLE_MS);

  if (await appWindow.isFullscreen()) {
    return;
  }

  if (maximized) {
    await appWindow.unmaximize();
    await waitForWindowState(WINDOW_STATE_SETTLE_MS);
  }

  await appWindow.setFullscreen(true);
}
