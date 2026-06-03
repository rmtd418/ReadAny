/**
 * usePagination — handles page flip and scroll navigation via
 * mouse events from the host container and iframe bridge.
 *
 * Strategy: Leading-edge throttle with "idle unlock".
 */
import { useCallback, useEffect, useRef } from "react";
import type { FoliateView } from "./useFoliateView";

interface UsePaginationOptions {
  bookKey: string;
  viewRef: React.RefObject<FoliateView | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/** Minimum cooldown after a page turn (ms) */
const WHEEL_MIN_COOLDOWN_MS = 350;

/** After the last wheel event, wait this long before unlocking (ms). */
const WHEEL_IDLE_MS = 200;

const WHEEL_LINE_HEIGHT = 16;
const CONTINUOUS_SCROLL_DELAY_MS = 100;
const CONTINUOUS_SCROLL_DEBOUNCE_MS = 160;
const CONTINUOUS_SCROLL_PRELOAD_RATIO = 0.35;
const CONTINUOUS_SCROLL_MIN_PRELOAD_PX = 96;

const wheelDeltaToPixels = (delta: number, deltaMode = 0) => {
  if (deltaMode === 1) return delta * WHEEL_LINE_HEIGHT;
  if (deltaMode === 2) {
    const pageSize = typeof window === "undefined" ? 800 : window.innerHeight;
    return delta * pageSize;
  }
  return delta;
};

export function usePagination({ bookKey, viewRef, containerRef }: UsePaginationOptions) {
  const wheelLocked = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockTime = useRef(0);
  const continuousScrollTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const continuousScrollDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queueContinuousScroll = useCallback((callback: () => void) => {
    const timer = setTimeout(() => {
      continuousScrollTimers.current.delete(timer);
      callback();
    }, CONTINUOUS_SCROLL_DELAY_MS);
    continuousScrollTimers.current.add(timer);
  }, []);

  const handleContinuousScroll = useCallback(
    (scrollDelta: number, threshold = 0) => {
      const view = viewRef.current;
      const renderer = view?.renderer;
      if (!view || !renderer?.scrolled) return false;

      const start = Number(renderer.start ?? 0);
      const end = Number(renderer.end ?? 0);
      const viewSize = Number(renderer.viewSize ?? 0);
      const size = Number(renderer.size ?? end - start);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        !Number.isFinite(viewSize) ||
        !Number.isFinite(size)
      ) {
        return false;
      }

      const triggerDistance = Math.max(
        CONTINUOUS_SCROLL_MIN_PRELOAD_PX,
        size * CONTINUOUS_SCROLL_PRELOAD_RATIO,
      );
      const remainingToEnd = Math.max(0, viewSize - end);

      if (scrollDelta > threshold && start <= triggerDistance) {
        const distance = Math.max(1, Math.ceil(start) + 1);
        queueContinuousScroll(() => {
          void viewRef.current?.prev(distance);
        });
        return true;
      }

      if (scrollDelta < -threshold && remainingToEnd <= triggerDistance) {
        const distance = Math.max(1, Math.ceil(remainingToEnd) + 1);
        queueContinuousScroll(() => {
          void viewRef.current?.next(distance);
        });
        return true;
      }

      return false;
    },
    [queueContinuousScroll, viewRef],
  );

  const handleScrolledWheel = useCallback(
    (deltaY: number, deltaX = 0, deltaMode = 0) => {
      const renderer = viewRef.current?.renderer;
      if (!renderer?.scrolled) return false;

      const pixelDeltaY = wheelDeltaToPixels(Number(deltaY) || 0, deltaMode);
      const pixelDeltaX = wheelDeltaToPixels(Number(deltaX) || 0, deltaMode);
      if (Math.abs(pixelDeltaY) < 2 && Math.abs(pixelDeltaX) < 2) return false;

      const scrollProp = String(renderer.scrollProp ?? "scrollTop");
      const scrollDelta =
        scrollProp === "scrollLeft"
          ? -(Math.abs(pixelDeltaX) > 0 ? pixelDeltaX : pixelDeltaY)
          : -pixelDeltaY;

      if (continuousScrollDebounceTimer.current) {
        clearTimeout(continuousScrollDebounceTimer.current);
      }
      continuousScrollDebounceTimer.current = setTimeout(() => {
        continuousScrollDebounceTimer.current = null;
        handleContinuousScroll(scrollDelta, 0);
      }, CONTINUOUS_SCROLL_DEBOUNCE_MS);

      return true;
    },
    [handleContinuousScroll, viewRef],
  );

  const handleWheel = useCallback(
    (deltaY: number, deltaX?: number) => {
      const view = viewRef.current;
      if (!view) return;

      if (view.renderer?.scrolled) return;

      const absDY = Math.abs(deltaY);
      const absDX = Math.abs(deltaX || 0);
      if (absDY < 2 && absDX < 2) return;

      if (wheelLocked.current) {
        if (idleTimer.current) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => {
          const elapsed = Date.now() - lockTime.current;
          if (elapsed >= WHEEL_MIN_COOLDOWN_MS) {
            wheelLocked.current = false;
          } else {
            idleTimer.current = setTimeout(() => {
              wheelLocked.current = false;
            }, WHEEL_MIN_COOLDOWN_MS - elapsed);
          }
        }, WHEEL_IDLE_MS);
        return;
      }

      let direction: "next" | "prev";
      if (absDY >= absDX) {
        direction = deltaY > 0 ? "next" : "prev";
      } else {
        direction = (deltaX || 0) > 0 ? "next" : "prev";
      }

      if (direction === "next") {
        view.next();
      } else {
        view.prev();
      }

      wheelLocked.current = true;
      lockTime.current = Date.now();
      idleTimer.current = setTimeout(() => {
        wheelLocked.current = false;
      }, WHEEL_IDLE_MS);
    },
    [viewRef],
  );

  useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (continuousScrollDebounceTimer.current) {
        clearTimeout(continuousScrollDebounceTimer.current);
        continuousScrollDebounceTimer.current = null;
      }
      for (const timer of continuousScrollTimers.current) clearTimeout(timer);
      continuousScrollTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data?.type || data.bookKey !== bookKey) return;

      switch (data.type) {
        case "iframe-wheel":
          if (viewRef.current?.renderer?.scrolled) {
            handleScrolledWheel(data.deltaY, data.deltaX, data.deltaMode);
            return;
          }
          handleWheel(data.deltaY, data.deltaX);
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [bookKey, handleScrolledWheel, handleWheel, viewRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (viewRef.current?.renderer?.scrolled) {
        handleScrolledWheel(e.deltaY, e.deltaX, e.deltaMode);
        return;
      }
      e.preventDefault();
      handleWheel(e.deltaY, e.deltaX);
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [containerRef, handleScrolledWheel, handleWheel, viewRef]);

  return { handleWheel, handleContinuousScroll };
}
