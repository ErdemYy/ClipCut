"use client";

import { memo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatTime } from "@/lib/api";
import {
  CLIP_MAX_SECONDS,
  CLIP_MIN_SECONDS,
  clampClipRange,
  constrainClipEdge,
  moveClipRange,
  type ClipEdge,
  type ClipRangeAction,
  type ClipRange,
} from "@/lib/clip-trim";
import pub from "./publishing.module.css";

type Props = {
  label: string;
  duration: number;
  range: ClipRange;
  peaks?: number[];
  disabled?: boolean;
  describedBy?: string;
  onChange: (range: ClipRange) => void;
  onCommit: (range: ClipRange, edge: ClipRangeAction) => void;
  onGestureChange?: (active: boolean) => void;
};

type View = { start: number; end: number };
type Drag = {
  pointerId: number;
  edge: ClipRangeAction;
  startX: number;
  width: number;
  base: ClipRange;
  viewStart: number;
  viewEnd: number;
  lastValue: number;
};

const BARS = 160;
const quantize = (value: number) => Math.round(value * 10) / 10;
const rounded = (value: number) => Math.round(value * 1000) / 1000;
const actionValue = (range: ClipRange, action: ClipRangeAction) => range[action === "move" ? "start" : action];

function computedView(range: ClipRange, duration: number): View {
  const low = Math.min(range.start, range.end);
  const high = Math.max(range.start, range.end);
  const pad = Math.min(30, Math.max(15, high - low));
  return {
    start: Math.max(0, low - pad),
    end: Math.min(duration, high + pad),
  };
}

const WaveformBars = memo(function WaveformBars({
  peaks, duration, start, end,
}: { peaks?: number[]; duration: number; start: number; end: number }) {
  if (!peaks?.length || end <= start) {
    return <svg className={pub.trimWaveSvg} viewBox={`0 0 ${BARS} 48`} preserveAspectRatio="none" aria-hidden="true">
      <line className={pub.trimWaveLine} x1="0" x2={BARS} y1="24" y2="24" vectorEffect="non-scaling-stroke" />
    </svg>;
  }
  const raw = Array.from({ length: BARS }, (_, index) => {
    const time = start + ((index + 0.5) / BARS) * (end - start);
    const peakIndex = Math.min(peaks.length - 1, Math.max(0, Math.floor((time / duration) * peaks.length)));
    const peak = Number.isFinite(peaks[peakIndex]) ? peaks[peakIndex] : 0;
    return Math.max(0, Math.min(1, Math.abs(peak)));
  });
  // Peaks are raw source amplitudes; quiet recordings still need a readable
  // drawing. Scale only the visible window and keep the data untouched.
  const scale = Math.max(0.03, ...raw);
  const values = raw.map((peak) => Math.min(0.95, (peak / scale) * 0.9));
  return <svg className={pub.trimWaveSvg} viewBox={`0 0 ${BARS} 48`} preserveAspectRatio="none" aria-hidden="true">
    {values.map((peak, index) => <line key={index} className={pub.trimWaveLine}
      x1={index + 0.5} x2={index + 0.5} y1={24 - peak * 22} y2={24 + peak * 22}
      vectorEffect="non-scaling-stroke" />)}
  </svg>;
});

export default function ClipRangeStrip({
  label, duration, range, peaks, disabled = false, describedBy, onChange, onCommit, onGestureChange,
}: Props) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safe = clampClipRange(range, total);
  const displayStart = Math.min(safe.start, safe.end);
  const displayEnd = Math.max(safe.start, safe.end);
  const viewFromRange = computedView(safe, total);
  const [dragView, setDragView] = useState<View | null>(null);
  const view = dragView ?? viewFromRange;
  const span = Math.max(0.001, view.end - view.start);
  const pct = (value: number) => Math.min(100, Math.max(0, ((value - view.start) / span) * 100));
  const startPct = pct(displayStart);
  const endPct = pct(displayEnd);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const startMin = Math.max(0, safe.end - CLIP_MAX_SECONDS);
  const startMax = Math.max(startMin, safe.end - CLIP_MIN_SECONDS);
  const endMin = Math.min(total, safe.start + CLIP_MIN_SECONDS);
  const endMax = Math.max(endMin, Math.min(total, safe.start + CLIP_MAX_SECONDS));

  if (total <= 0) return null;

  const rangeAt = (state: Drag, clientX: number): ClipRange => {
    const delta = ((clientX - state.startX) / state.width) * (state.viewEnd - state.viewStart);
    if (state.edge === "move")
      return moveClipRange(state.base, quantize(delta), total, state.viewStart, state.viewEnd);
    return constrainClipEdge(
      state.edge, quantize(state.base[state.edge] + delta), state.base, total, state.viewStart, state.viewEnd,
    );
  };

  const begin = (edge: ClipRangeAction, event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || drag.current || event.button !== 0 || !track.current) return;
    const width = track.current.getBoundingClientRect().width;
    if (width <= 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const base = { ...safe };
    drag.current = {
      pointerId: event.pointerId, edge, startX: event.clientX, width, base,
      viewStart: view.start, viewEnd: view.end, lastValue: actionValue(base, edge),
    };
    setDragView(view);
    onGestureChange?.(true);
  };

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId || disabled) return;
    const next = rangeAt(state, event.clientX);
    if (actionValue(next, state.edge) === state.lastValue) return;
    state.lastValue = actionValue(next, state.edge);
    onChange(next);
  };

  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    onGestureChange?.(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragView(null);
    if (cancel || disabled) {
      if (state.lastValue !== actionValue(state.base, state.edge)) onChange(state.base);
      return;
    }
    const next = rangeAt(state, event.clientX);
    if (actionValue(next, state.edge) !== state.lastValue) {
      state.lastValue = actionValue(next, state.edge);
      onChange(next);
    }
    if (actionValue(next, state.edge) !== actionValue(state.base, state.edge)) onCommit(next, state.edge);
  };

  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, edge: ClipRangeAction) => {
    const active = drag.current;
    if (event.key === "Escape" && active) {
      event.preventDefault();
      drag.current = null;
      onGestureChange?.(false);
      if (event.currentTarget.hasPointerCapture(active.pointerId))
        event.currentTarget.releasePointerCapture(active.pointerId);
      setDragView(null);
      if (active.lastValue !== actionValue(active.base, active.edge)) onChange(active.base);
      return;
    }
    if (disabled || active) return;

    let value: number;
    if (event.key === "Home") value = 0;
    else if (event.key === "End") value = total;
    else if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(event.key)) {
      const step = event.shiftKey ? 1 : 0.1;
      const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
      value = actionValue(safe, edge) + direction * step;
    } else return;

    event.preventDefault();
    // Keep the 0.1s step relative to the current value; re-gridding a value
    // such as 32.85 would turn one arrow press into a 0.15s jump.
    const next = edge === "move"
      ? moveClipRange(safe, value - safe.start, total)
      : constrainClipEdge(edge, value, safe, total);
    onChange(next);
    onCommit(next, edge);
  };

  const moveBy = (delta: number) => {
    if (disabled || drag.current) return;
    const next = moveClipRange(safe, delta, total);
    onChange(next);
    onCommit(next, "move");
  };

  const handle = (edge: ClipEdge, percentage: number) => {
    const value = safe[edge];
    const min = edge === "start" ? startMin : endMin;
    const max = edge === "start" ? startMax : endMax;
    const action = edge === "start" ? "başlangıç" : "bitiş";
    return <button type="button" role="slider" aria-orientation="horizontal"
      className={pub.trimHandle} style={{ left: `${percentage}%` }} disabled={disabled}
      aria-label={`${label} ${action} tutamacı`} aria-valuemin={rounded(min)} aria-valuemax={rounded(max)}
      aria-valuenow={rounded(value)} aria-valuetext={`${value.toFixed(1)} saniye`}
      aria-describedby={describedBy}
      title={`${label} ${action}: ${value.toFixed(1)} sn. Sürükleyin veya ok tuşlarını kullanın.`}
      onPointerDown={(event) => begin(edge, event)} onPointerMove={move} onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}
      onKeyDown={(event) => keyboard(event, edge)} />;
  };

  return <div className={pub.trimStripGroup} role="group" aria-label={`${label} klip aralığı dalga formu`}>
    <div className={pub.trimStrip} data-disabled={disabled || undefined}>
      <div ref={track} className={pub.trimTrack}>
        <div className={pub.trimCanvas}>
          <WaveformBars peaks={peaks} duration={total} start={view.start} end={view.end} />
          <div className={pub.trimShade} style={{ left: 0, width: `${startPct}%` }} />
          <div className={pub.trimShade} style={{ left: `${endPct}%`, right: 0 }} />
          <div className={pub.trimSelection} style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
        </div>
        <button type="button" role="slider" aria-orientation="horizontal"
          className={pub.trimMove} style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          disabled={disabled} aria-label={`${label} aralığı taşı`}
          aria-valuemin={0} aria-valuemax={rounded(Math.max(0, total - (safe.end - safe.start)))}
          aria-valuenow={rounded(safe.start)}
          aria-valuetext={`${safe.start.toFixed(1)} – ${safe.end.toFixed(1)} saniye; süre ${(safe.end - safe.start).toFixed(1)} saniye`}
          aria-describedby={describedBy} title="Süreyi koruyarak taşı: sürükleyin veya ok tuşlarını kullanın."
          onPointerDown={(event) => begin("move", event)} onPointerMove={move} onPointerUp={(event) => finish(event)}
          onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}
          onKeyDown={(event) => keyboard(event, "move")} />
        {handle("start", startPct)}
        {handle("end", endPct)}
      </div>
    </div>
    <div className={pub.trimMeta}>
      <span>Dalga {formatTime(view.start)} – {formatTime(view.end)}</span>
      <span>Seçili {safe.start.toFixed(1)} – {safe.end.toFixed(1)} sn · {Math.max(0, safe.end - safe.start).toFixed(1)} sn</span>
    </div>
    <div className={pub.actions} role="group" aria-label={`${label} süreyi koruyarak taşı`}>
      <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`} disabled={disabled || safe.start <= 0}
        onClick={() => moveBy(-1)}>1 sn erkene taşı</button>
      <button type="button" className={`btn btn-sm ${pub.trimShiftButton}`} disabled={disabled || safe.end >= total}
        onClick={() => moveBy(1)}>1 sn geçe taşı</button>
    </div>
  </div>;
}
