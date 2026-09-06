'use strict';

/**
 * Maps between frame numbers and media time.
 *
 * Two modes:
 *  - Analytic (default): constant frame rate, frame n starts at n / fps.
 *  - Indexed: an exact presentation timestamp per frame, from ffprobe. Required
 *    for variable-frame-rate sources (GIF conversions, screen captures, some
 *    exports) where n / fps drifts away from the real frame boundaries.
 *
 * Seeking always targets the *middle* of a frame's on-screen interval rather
 * than its start. Decoders resolve a seek to the frame covering the requested
 * time, so aiming at a boundary is the one place rounding can land a frame off.
 */
class FrameMap {
  constructor(info) {
    this.fps = info.fps > 0 ? info.fps : 24;
    this.duration = info.duration || 0;
    this.count = Math.max(1, info.frame_count || Math.round(this.duration * this.fps) || 1);
    this.exact = !!info.frame_count_exact;
    this.index = null;
  }

  /** Adopt an exact timestamp list (ascending, zero-based). */
  setIndex(times) {
    if (!times || times.length < 2) return false;
    this.index = times;
    this.count = times.length;
    this.exact = true;
    const span = times[times.length - 1] - times[0];
    if (span > 0) this.fps = (times.length - 1) / span;
    return true;
  }

  get indexed() {
    return this.index !== null;
  }

  get lastFrame() {
    return this.count - 1;
  }

  clamp(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.min(this.lastFrame, Math.max(0, Math.round(n)));
  }

  /** Time at which frame n begins. */
  startOf(n) {
    n = this.clamp(n);
    return this.index ? this.index[n] : n / this.fps;
  }

  /** How long frame n stays on screen. */
  durationOf(n) {
    n = this.clamp(n);
    if (!this.index) return 1 / this.fps;
    if (n < this.index.length - 1) return this.index[n + 1] - this.index[n];
    // Last frame: reuse the previous interval, or fall back to the duration.
    if (this.index.length > 1) return this.index[n] - this.index[n - 1];
    return 1 / this.fps;
  }

  /** Where to park currentTime so the decoder lands on exactly frame n. */
  seekTimeOf(n) {
    n = this.clamp(n);
    const start = this.startOf(n);
    const dur = Math.max(this.durationOf(n), 1e-6);
    return start + dur * 0.5;
  }

  /** Which frame is on screen at media time t. */
  frameAt(t) {
    if (!Number.isFinite(t) || t <= 0) return 0;
    if (!this.index) {
      // The epsilon absorbs float error when t is exactly on a boundary.
      return this.clamp(Math.floor(t * this.fps + 1e-4));
    }
    let lo = 0;
    let hi = this.index.length - 1;
    const probe = t + 1e-6;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.index[mid] <= probe) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** SMPTE-style HH:MM:SS:FF for frame n. */
  timecodeOf(n) {
    const fps = Math.max(1, Math.round(this.fps));
    const t = this.startOf(n);
    const whole = Math.floor(t);
    const ff = Math.min(fps - 1, Math.round((t - whole) * fps));
    const pad = (v, w = 2) => String(v).padStart(w, '0');
    return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}:${pad(ff)}`;
  }
}

window.FrameMap = FrameMap;
