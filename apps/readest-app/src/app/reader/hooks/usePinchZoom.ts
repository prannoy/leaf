import { useEffect, useRef, useCallback, useState } from 'react';

const MIN_SCALE = 1.0;
const MAX_SCALE = 5.0;

interface PinchZoomState {
  isPinching: boolean;
  isZoomed: boolean;
  scale: number;
}

// Module-level ref so other hooks can check pinch/zoom state without re-renders
export const pinchZoomStateRef: { current: PinchZoomState } = {
  current: { isPinching: false, isZoomed: false, scale: 1 },
};

interface ZoomState {
  scale: number;
  translateX: number;
  translateY: number;
  isZoomed: boolean;
}

interface TouchPoint {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

interface UsePinchZoomOptions {
  enabled: boolean;
}

const getDistance = (t1: TouchPoint, t2: TouchPoint) =>
  Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

const getMidpoint = (t1: TouchPoint, t2: TouchPoint) => ({
  x: (t1.clientX + t2.clientX) / 2,
  y: (t1.clientY + t2.clientY) / 2,
});

const getZoomedOffset = (
  anchorX: number,
  anchorY: number,
  currentScale: number,
  nextScale: number,
  currentPos: { x: number; y: number },
) => {
  const scaleChange = nextScale / currentScale;
  return {
    x: anchorX - (anchorX - currentPos.x) * scaleChange,
    y: anchorY - (anchorY - currentPos.y) * scaleChange,
  };
};

export const usePinchZoom = (
  bookKey: string,
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UsePinchZoomOptions,
) => {
  const { enabled } = options;

  const [zoomState, setZoomState] = useState<ZoomState>({
    scale: 1,
    translateX: 0,
    translateY: 0,
    isZoomed: false,
  });

  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });
  const isPinchingRef = useRef(false);
  const lastDistanceRef = useRef(0);
  const panStartRef = useRef({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const updateState = useCallback((scale: number, tx: number, ty: number) => {
    scaleRef.current = scale;
    translateRef.current = { x: tx, y: ty };
    const isZoomed = scale > 1.01;
    pinchZoomStateRef.current = {
      isPinching: isPinchingRef.current,
      isZoomed,
      scale,
    };
    setZoomState({ scale, translateX: tx, translateY: ty, isZoomed });
  }, []);

  const resetZoom = useCallback(() => {
    isPinchingRef.current = false;
    isPanningRef.current = false;
    pinchZoomStateRef.current = { isPinching: false, isZoomed: false, scale: 1 };
    updateState(1, 0, 0);
    containerRef.current?.classList.remove('zoomed');
  }, [updateState, containerRef]);

  // Handle iframe touch messages (touches originating inside the iframe)
  useEffect(() => {
    if (!enabled) return;

    const handleMessage = (msg: MessageEvent) => {
      if (!msg.data || msg.data.bookKey !== bookKey) return;

      const touches: TouchPoint[] = msg.data.targetTouches || [];
      const touchCount: number = msg.data.touchCount ?? touches.length;

      if (msg.data.type === 'iframe-touchstart') {
        if (touchCount >= 2 && touches.length >= 2) {
          isPinchingRef.current = true;
          pinchZoomStateRef.current = {
            ...pinchZoomStateRef.current,
            isPinching: true,
          };
          lastDistanceRef.current = getDistance(touches[0]!, touches[1]!);
        } else if (touchCount === 1 && touches.length >= 1 && scaleRef.current > 1.01) {
          // Single finger pan when zoomed
          isPanningRef.current = true;
          panStartRef.current = {
            x: touches[0]!.clientX - translateRef.current.x,
            y: touches[0]!.clientY - translateRef.current.y,
          };
        }
      } else if (msg.data.type === 'iframe-touchmove') {
        if (isPinchingRef.current && touches.length >= 2) {
          const currentDistance = getDistance(touches[0]!, touches[1]!);
          const distanceChange = currentDistance / lastDistanceRef.current;

          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            const newScale = Math.min(
              Math.max(scaleRef.current * distanceChange, MIN_SCALE),
              MAX_SCALE,
            );

            if (newScale <= 1.0) {
              updateState(1, 0, 0);
              containerRef.current?.classList.remove('zoomed');
              lastDistanceRef.current = currentDistance;
              return;
            }

            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) {
              lastDistanceRef.current = currentDistance;
              return;
            }

            const mid = getMidpoint(touches[0]!, touches[1]!);
            const anchorX = mid.x - rect.left - rect.width / 2;
            const anchorY = mid.y - rect.top - rect.height / 2;

            const newPos = getZoomedOffset(
              anchorX,
              anchorY,
              scaleRef.current,
              newScale,
              translateRef.current,
            );

            updateState(newScale, newPos.x, newPos.y);
            containerRef.current?.classList.add('zoomed');
            lastDistanceRef.current = currentDistance;
          });
        } else if (isPanningRef.current && touches.length >= 1 && scaleRef.current > 1.01) {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            const newX = touches[0]!.clientX - panStartRef.current.x;
            const newY = touches[0]!.clientY - panStartRef.current.y;
            updateState(scaleRef.current, newX, newY);
          });
        }
      } else if (msg.data.type === 'iframe-touchend') {
        if (isPinchingRef.current) {
          isPinchingRef.current = false;
          pinchZoomStateRef.current = {
            ...pinchZoomStateRef.current,
            isPinching: false,
          };
          // If a single finger remains, transition to panning
          if (touchCount === 1 && touches.length >= 1 && scaleRef.current > 1.01) {
            isPanningRef.current = true;
            panStartRef.current = {
              x: touches[0]!.clientX - translateRef.current.x,
              y: touches[0]!.clientY - translateRef.current.y,
            };
          }
        }
        if (touchCount === 0) {
          isPanningRef.current = false;
          isPinchingRef.current = false;
          pinchZoomStateRef.current = {
            ...pinchZoomStateRef.current,
            isPinching: false,
          };
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, bookKey, updateState, containerRef]);

  // Handle native touch events on the container (for touches starting outside iframe)
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        isPinchingRef.current = true;
        pinchZoomStateRef.current = {
          ...pinchZoomStateRef.current,
          isPinching: true,
        };
        lastDistanceRef.current = Math.hypot(
          e.touches[0]!.clientX - e.touches[1]!.clientX,
          e.touches[0]!.clientY - e.touches[1]!.clientY,
        );
      } else if (e.touches.length === 1 && scaleRef.current > 1.01) {
        e.preventDefault();
        isPanningRef.current = true;
        panStartRef.current = {
          x: e.touches[0]!.clientX - translateRef.current.x,
          y: e.touches[0]!.clientY - translateRef.current.y,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (isPinchingRef.current && e.touches.length >= 2) {
        e.preventDefault();
        const currentDistance = Math.hypot(
          e.touches[0]!.clientX - e.touches[1]!.clientX,
          e.touches[0]!.clientY - e.touches[1]!.clientY,
        );
        const distanceChange = currentDistance / lastDistanceRef.current;

        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const newScale = Math.min(
            Math.max(scaleRef.current * distanceChange, MIN_SCALE),
            MAX_SCALE,
          );

          if (newScale <= 1.0) {
            updateState(1, 0, 0);
            container.classList.remove('zoomed');
            lastDistanceRef.current = currentDistance;
            return;
          }

          const rect = container.getBoundingClientRect();
          const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2;
          const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2;
          const anchorX = midX - rect.left - rect.width / 2;
          const anchorY = midY - rect.top - rect.height / 2;

          const newPos = getZoomedOffset(
            anchorX,
            anchorY,
            scaleRef.current,
            newScale,
            translateRef.current,
          );

          updateState(newScale, newPos.x, newPos.y);
          container.classList.add('zoomed');
          lastDistanceRef.current = currentDistance;
        });
      } else if (isPanningRef.current && e.touches.length === 1 && scaleRef.current > 1.01) {
        e.preventDefault();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          const newX = e.touches[0]!.clientX - panStartRef.current.x;
          const newY = e.touches[0]!.clientY - panStartRef.current.y;
          updateState(scaleRef.current, newX, newY);
        });
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (isPinchingRef.current) {
        isPinchingRef.current = false;
        pinchZoomStateRef.current = {
          ...pinchZoomStateRef.current,
          isPinching: false,
        };
        if (e.touches.length === 1 && scaleRef.current > 1.01) {
          isPanningRef.current = true;
          panStartRef.current = {
            x: e.touches[0]!.clientX - translateRef.current.x,
            y: e.touches[0]!.clientY - translateRef.current.y,
          };
        }
      }
      if (e.touches.length === 0) {
        isPanningRef.current = false;
        isPinchingRef.current = false;
        pinchZoomStateRef.current = {
          ...pinchZoomStateRef.current,
          isPinching: false,
        };
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, [enabled, containerRef, updateState]);

  const isPinching = isPinchingRef.current;
  const zoomStyle: React.CSSProperties = {
    transform: `scale(${zoomState.scale}) translate(${zoomState.translateX / zoomState.scale}px, ${zoomState.translateY / zoomState.scale}px)`,
    transformOrigin: 'center center',
    transition: isPinching ? 'none' : 'transform 0.2s ease-out',
  };

  return {
    zoomState,
    resetZoom,
    zoomStyle: enabled ? zoomStyle : undefined,
    isZoomActive: zoomState.isZoomed,
  };
};
