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

  if (maximized) {
    await appWindow.unmaximize();
    await waitForWindowState(WINDOW_STATE_SETTLE_MS);
  }

  await appWindow.setFullscreen(true);
}
