"use client";

import { useEffect, useRef } from "react";

/**
 * Monochrome dotted globe: points on a rotating sphere, drawn as tiny dots.
 * Pure canvas, no dependencies. Drag to rotate, releases resume auto-spin.
 */
export default function Globe({ size = 620 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // fibonacci sphere point cloud
    const N = 1100;
    const pts: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = i * 2.399963229728653 + 2.1; // golden angle + offset decorrelation
      pts.push([r * Math.cos(theta), y, r * Math.sin(theta)]);
    }

    const R = size / 2 - 12;
    const cx = size / 2;
    const cy = size / 2;

    let rotY = 0;      // auto rotation state
    let velY = 0.0022; // spin speed
    let rotX = -0.28;  // slight tilt
    let dragX: number | null = null;
    let dragY: number | null = null;
    let raf = 0;

    const foreground = () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--foreground")
        .trim() || "#131313";

    const draw = () => {
      rotY += velY;
      const fg = foreground();
      ctx.clearRect(0, 0, size, size);

      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      for (const [x0, y0, z0] of pts) {
        // rotate around Y
        const x1 = x0 * cosY - z0 * sinY;
        const z1 = x0 * sinY + z0 * cosY;
        // rotate around X
        const y1 = y0 * cosX - z1 * sinX;
        const z2 = y0 * sinX + z1 * cosX;

        const depth = (z2 + 1) / 2; // 0 back .. 1 front
        if (depth < 0.06) continue; // cull the darkest back side

        const px = cx + x1 * R;
        const py = cy + y1 * R;

        // front-most points solid and larger; back points faint
        const alpha = 0.12 + depth * 0.88;
        const d = 0.7 + depth * 1.15;
        ctx.globalAlpha = alpha * alpha * 0.9 + alpha * 0.1;
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.arc(px, py, d, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // halo ring
      ctx.strokeStyle = fg;
      ctx.globalAlpha = 0.12;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(draw);
    };

    const onDown = (e: PointerEvent) => {
      dragX = e.clientX;
      dragY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (dragX == null) return;
      velY = 0;
      rotY += (e.clientX - dragX) * 0.006;
      if (dragY != null) {
        rotX = Math.max(-1.2, Math.min(1.2, rotX + (e.clientY - dragY) * 0.006));
      }
      dragX = e.clientX;
      dragY = e.clientY;
    };
    const onUp = () => {
      dragX = null;
      dragY = null;
      velY = 0.0022;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onUp);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, cursor: "grab", touchAction: "none" }}
      aria-label="Rotating dotted globe"
    />
  );
}
