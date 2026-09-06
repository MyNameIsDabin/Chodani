'use strict';

/* ------------------------------------------------------------------ *
 * Tauri bridge
 * ------------------------------------------------------------------ */

const { invoke, Channel } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** Dialog plugin commands are called directly so no JS bundle step is needed. */
const dialog = {
  open: (options) => invoke('plugin:dialog|open', { options }),
  save: (options) => invoke('plugin:dialog|save', { options }),
};

/** The dialog plugin may answer with a string, a {path} object, or a list. */
function asPath(result) {
  if (!result) return null;
  const one = Array.isArray(result) ? result[0] : result;
  if (!one) return null;
  return typeof one === 'string' ? one : one.path || null;
}

const VIDEO_FILTER = {
  name: '영상 / GIF',
  extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'gif', 'wmv', 'mpg', 'mpeg', 'ts', 'flv'],
};

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'), pan: $('pan'), frameBox: $('frame-box'), video: $('video'),
  onionPrev: $('onion-prev'), onionNext: $('onion-next'), pinOverlay: $('pin-overlay'),
  compareBox: $('compare-box'), pinCanvas: $('pin-canvas'), pinLabel: $('pin-label'),
  dropHint: $('drop-hint'), stageBadge: $('stage-badge'),
  title: $('media-title'), meta: $('media-meta'),
  frameInput: $('frame-input'), frameTotal: $('frame-total'),
  timecode: $('timecode'),
  timeline: $('timeline'), playhead: $('playhead'), markerLane: $('marker-lane'),
  loopBand: $('loop-band'), buffered: $('buffered'),
  btnPlay: $('btn-play'), stepSize: $('step-size'), speed: $('speed'),
  btnLoop: $('btn-loop'),
  markerList: $('marker-list'), markerEmpty: $('marker-empty'), markerFilter: $('marker-filter'),
  saveState: $('save-state'),
  recentList: $('recent-list'), toolStatus: $('tool-status'),
  urlInput: $('url-input'),
  streamQuality: $('stream-quality'), streamHeight: $('stream-height'), streamDownload: $('stream-download'),
  onionOn: $('onion-on'), onionGap: $('onion-gap'), onionPrevOp: $('onion-prev-op'),
  onionNextOp: $('onion-next-op'), onionBlend: $('onion-blend'), onionTint: $('onion-tint'),
  compareMode: $('compare-mode'), pinOpacity: $('pin-opacity'), flipRow: $('flip-row'),
  toast: $('toast'), busy: $('busy'), busyText: $('busy-text'), busyBar: $('busy-bar'),
  notebar: $('notebar'), noteInline: $('note-inline'), noteColors: $('note-colors'),
  noteFrameLabel: $('note-frame-label'), noteState: $('note-state'),
  helpDialog: $('help-dialog'), helpGrid: $('help-grid'),
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const MARKER_COLORS = ['#ffc247', '#5aa2ff', '#56d38a', '#ff6b6b', '#c58aff', '#ffffff'];

const state = {
  info: null,
  fmap: null,
  /** Frame the user intends to be on. Drives every readout. */
  cursor: 0,
  /** Frame the decoder last actually presented. */
  actual: 0,
  pending: null,
  seeking: false,
  playing: false,
  markers: [],
  loopA: null,
  loopB: null,
  looping: false,
  pinned: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  saveTimer: null,
};

/* ------------------------------------------------------------------ *
 * Chrome: toast / busy
 * ------------------------------------------------------------------ */

let toastTimer = null;
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, isError ? 6000 : 2600);
}

function busy(text, withProgress = false) {
  el.busyText.textContent = text;
  el.busy.hidden = false;
  el.busyBar.parentElement.hidden = !withProgress;
  el.busyBar.style.width = '0%';
}
function busyProgress(ratio) {
  el.busyBar.style.width = `${Math.round(ratio * 100)}%`;
}
function busyDone() {
  el.busy.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Seek engine
 * ------------------------------------------------------------------ */

function loaded() {
  return state.fmap !== null;
}

/**
 * Request frame `n`. Repeated calls while a seek is in flight collapse into a
 * single follow-up seek, so holding an arrow key stays responsive instead of
 * queueing dozens of seeks the decoder has to chew through.
 */
function goToFrame(n, { pause = true } = {}) {
  if (!loaded()) return;
  if (pause && state.playing) setPlaying(false);
  state.cursor = state.fmap.clamp(n);
  renderReadout();
  state.pending = state.cursor;
  syncNote();
  if (!state.seeking) flushSeek();
}

function flushSeek() {
  if (state.pending === null) return;
  const target = state.pending;
  state.pending = null;
  state.seeking = true;
  el.video.currentTime = state.fmap.seekTimeOf(target);
}

function onSeeked() {
  state.seeking = false;
  if (state.pending !== null) {
    flushSeek();
    return;
  }
  settle();
}

/** Called once the decoder has stopped moving: sync UI to the real frame. */
function settle() {
  if (!loaded()) return;
  state.actual = state.fmap.frameAt(el.video.currentTime);
  if (!state.playing) state.cursor = state.actual;
  renderReadout();
  syncNote();
  captureCurrent();
  scheduleOverlays();
}

function step(delta) {
  goToFrame((state.pending ?? state.cursor) + delta);
}

/**
 * Bumped on every intent change so a `play()` promise that settles late cannot
 * report on a decision the user has already moved past.
 */
let playIntent = 0;

function setPlaying(on) {
  if (!loaded()) return;
  const intent = ++playIntent;
  state.playing = on;
  el.btnPlay.classList.toggle('is-playing', on);

  // Notes are not synced frame by frame during playback, so rather than let the
  // bar sit on a stale frame number it goes inert until playback stops.
  el.notebar.classList.toggle('is-idle', on);
  el.noteInline.disabled = on;
  if (on) {
    flushNote();
    el.noteFrameLabel.textContent = '—';
    el.noteState.textContent = '';
    clearOverlays();
    // play() only settles once playback actually begins, which can take a
    // while behind a pending seek or an unbuffered stream. Pausing, stepping
    // or opening another file before then rejects it with AbortError. That is
    // the user changing their mind mid-request, not a failure to report — and
    // acting on it would also flip the UI out of sync with a newer intent.
    Promise.resolve(el.video.play()).catch((e) => {
      if (intent !== playIntent || e.name === 'AbortError') return;
      state.playing = false;
      el.btnPlay.classList.remove('is-playing');
      toast(`재생할 수 없습니다: ${e.message}`, true);
    });
  } else {
    el.video.pause();
    // Land exactly on the frame that was showing when playback stopped.
    goToFrame(state.actual, { pause: false });
    // Forced: stopping on the frame playback started from leaves the cursor
    // unchanged, and syncNote would otherwise skip restoring the label.
    syncNote(true);
  }
}

/* Frame presentation callback -------------------------------------- */

const hasRVFC = typeof HTMLVideoElement !== 'undefined'
  && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function onPresented(_now, meta) {
  if (loaded()) {
    state.actual = state.fmap.frameAt(meta.mediaTime);
    if (state.playing) {
      state.cursor = state.actual;
      renderReadout();
      enforceLoop();
    }
  }
  el.video.requestVideoFrameCallback(onPresented);
}

function pollFallback() {
  if (loaded() && state.playing) {
    state.actual = state.fmap.frameAt(el.video.currentTime);
    state.cursor = state.actual;
    renderReadout();
    enforceLoop();
  }
  requestAnimationFrame(pollFallback);
}

function enforceLoop() {
  if (!state.looping || state.loopA === null || state.loopB === null) return;
  if (state.actual >= state.loopB || state.actual < state.loopA) {
    el.video.currentTime = state.fmap.seekTimeOf(state.loopA);
  }
}

/* ------------------------------------------------------------------ *
 * Readouts
 * ------------------------------------------------------------------ */

function renderReadout() {
  if (!loaded()) return;
  const f = state.cursor;
  if (document.activeElement !== el.frameInput) el.frameInput.value = String(f);
  el.timecode.textContent = state.fmap.timecodeOf(f);
  const ratio = state.fmap.lastFrame > 0 ? f / state.fmap.lastFrame : 0;
  el.playhead.style.left = `${ratio * 100}%`;
  highlightMarker(f);
}

function renderBuffered() {
  const v = el.video;
  if (!v.duration || !v.buffered.length) return;
  let end = 0;
  for (let i = 0; i < v.buffered.length; i += 1) end = Math.max(end, v.buffered.end(i));
  el.buffered.style.width = `${Math.min(100, (end / v.duration) * 100)}%`;
}

function renderMeta() {
  const i = state.info;
  if (!i) return;
  el.title.textContent = i.title;
  const bits = [
    `${i.width}×${i.height}`,
    `${state.fmap.fps.toFixed(3)} fps`,
    `${state.fmap.count} frames`,
    i.codec.toUpperCase(),
  ];
  if (i.transcoded) bits.push('변환됨');
  if (!i.has_audio) bits.push('무음');
  // Local files with uneven timestamps get indexed exactly; a remote stream
  // cannot be without downloading all of it, so say so rather than imply
  // a precision we do not have.
  if (i.variable_frame_rate && !state.fmap.indexed) bits.push('프레임 번호 추정');
  el.meta.textContent = bits.join(' · ');
  el.frameTotal.textContent = String(state.fmap.lastFrame);
}

/* ------------------------------------------------------------------ *
 * Frame capture + onion skin
 * ------------------------------------------------------------------ */

/**
 * A second decoder used to fetch frames the main video is not sitting on
 * (onion skin neighbours, pinned frames). It has to live in the document —
 * a detached element is not guaranteed to decode — but stays invisible.
 */
const helper = document.createElement('video');
helper.crossOrigin = 'anonymous';
helper.muted = true;
helper.preload = 'auto';
helper.style.cssText = 'position:absolute;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
document.body.appendChild(helper);

const frameCache = new Map();
const CACHE_LIMIT = 96;

function cachePut(n, bitmap) {
  if (frameCache.has(n)) frameCache.get(n).close?.();
  frameCache.set(n, bitmap);
  while (frameCache.size > CACHE_LIMIT) {
    const oldest = frameCache.keys().next().value;
    frameCache.get(oldest).close?.();
    frameCache.delete(oldest);
  }
}

function clearCache() {
  for (const b of frameCache.values()) b.close?.();
  frameCache.clear();
}

/** Cheap win: every frame we settle on is a frame onion skin may want next. */
async function captureCurrent() {
  if (!loaded() || el.video.readyState < 2) return;
  const n = state.actual;
  if (frameCache.has(n)) return;
  try {
    cachePut(n, await createImageBitmap(el.video));
  } catch { /* the decoder was mid-seek; the next settle will retry */ }
}

let helperReady = false;
function helperSeek(time) {
  return new Promise((resolve) => {
    const done = () => { helper.removeEventListener('seeked', done); resolve(); };
    helper.addEventListener('seeked', done);
    helper.currentTime = time;
  });
}

async function grabFrame(n) {
  if (frameCache.has(n)) return frameCache.get(n);
  if (!helperReady) return null;
  await helperSeek(state.fmap.seekTimeOf(n));
  try {
    const bitmap = await createImageBitmap(helper);
    cachePut(n, bitmap);
    return bitmap;
  } catch {
    return null;
  }
}

function sizeCanvas(canvas) {
  const w = el.video.videoWidth;
  const h = el.video.videoHeight;
  if (!w || !h) return false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return true;
}

function paint(canvas, bitmap, tint) {
  if (!sizeCanvas(canvas)) return;
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bitmap) return;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (tint) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function clearOverlays() {
  el.onionPrev.style.opacity = '0';
  el.onionNext.style.opacity = '0';
}

let overlayToken = 0;
function scheduleOverlays() {
  if (!el.onionOn.checked || state.playing || !loaded()) {
    clearOverlays();
    return;
  }
  const token = ++overlayToken;
  const gap = Math.max(1, Number(el.onionGap.value) || 1);
  const base = state.actual;
  const tinted = el.onionTint.checked;
  const blend = el.onionBlend.value;

  (async () => {
    const prev = base - gap >= 0 ? await grabFrame(base - gap) : null;
    if (token !== overlayToken) return;
    paint(el.onionPrev, prev, tinted ? '#ff8080' : null);
    el.onionPrev.style.mixBlendMode = blend;
    el.onionPrev.style.opacity = prev ? String(Number(el.onionPrevOp.value) / 100) : '0';

    const next = base + gap <= state.fmap.lastFrame ? await grabFrame(base + gap) : null;
    if (token !== overlayToken) return;
    paint(el.onionNext, next, tinted ? '#80ff9a' : null);
    el.onionNext.style.mixBlendMode = blend;
    el.onionNext.style.opacity = next ? String(Number(el.onionNextOp.value) / 100) : '0';
  })();
}

/* Pinned-frame comparison ------------------------------------------ */

async function pinCurrent() {
  if (!loaded()) return;
  const bitmap = frameCache.get(state.actual) || await grabFrame(state.actual);
  if (!bitmap) { toast('프레임을 고정하지 못했습니다.', true); return; }
  // Copy out of the cache: cached bitmaps get closed as the cache rolls over.
  const keep = document.createElement('canvas');
  keep.width = bitmap.width;
  keep.height = bitmap.height;
  keep.getContext('2d').drawImage(bitmap, 0, 0);
  state.pinned = { frame: state.actual, bitmap: keep };
  el.pinLabel.textContent = String(state.actual);
  if (el.compareMode.value === 'off') el.compareMode.value = 'split';
  renderCompare();
  toast(`프레임 ${state.actual} 고정`);
}

function unpin() {
  state.pinned = null;
  el.compareMode.value = 'off';
  renderCompare();
}

function renderCompare() {
  const mode = el.compareMode.value;
  const has = !!state.pinned;
  el.flipRow.hidden = mode !== 'flip';
  el.compareBox.hidden = !(has && mode === 'split');
  el.pan.classList.toggle('is-split', has && mode === 'split');

  if (has && mode === 'split') {
    paint(el.pinCanvas, state.pinned.bitmap, null);
  }
  if (has && mode === 'flip') {
    paint(el.pinOverlay, state.pinned.bitmap, null);
    el.pinOverlay.style.opacity = String(Number(el.pinOpacity.value) / 100);
  } else {
    el.pinOverlay.style.opacity = '0';
  }
  el.stageBadge.hidden = !(has && mode === 'flip');
  if (!el.stageBadge.hidden) el.stageBadge.textContent = `고정 ${state.pinned.frame} 표시 중`;
}

/* ------------------------------------------------------------------ *
 * Zoom / pan
 * ------------------------------------------------------------------ */

function applyTransform() {
  el.pan.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
}

function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyTransform();
}

el.stage.addEventListener('wheel', (e) => {
  if (!loaded()) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  state.zoom = Math.min(12, Math.max(0.2, state.zoom * factor));
  applyTransform();
}, { passive: false });

let dragging = null;
el.stage.addEventListener('pointerdown', (e) => {
  if (!loaded() || e.button !== 0) return;
  dragging = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
  el.stage.setPointerCapture(e.pointerId);
  el.stage.classList.add('is-panning');
});
el.stage.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  state.panX = dragging.px + (e.clientX - dragging.x);
  state.panY = dragging.py + (e.clientY - dragging.y);
  applyTransform();
});
const endDrag = () => { dragging = null; el.stage.classList.remove('is-panning'); };
el.stage.addEventListener('pointerup', endDrag);
el.stage.addEventListener('pointercancel', endDrag);

/* ------------------------------------------------------------------ *
 * Timeline
 * ------------------------------------------------------------------ */

function frameFromPointer(e) {
  const rect = el.timeline.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return Math.round(ratio * state.fmap.lastFrame);
}

let scrubbing = false;
el.timeline.addEventListener('pointerdown', (e) => {
  if (!loaded()) return;
  scrubbing = true;
  el.timeline.setPointerCapture(e.pointerId);
  goToFrame(frameFromPointer(e));
});
el.timeline.addEventListener('pointermove', (e) => {
  if (scrubbing) goToFrame(frameFromPointer(e));
});
el.timeline.addEventListener('pointerup', () => { scrubbing = false; });

function renderLoopBand() {
  const { loopA, loopB } = state;
  if (loopA === null || loopB === null || !loaded()) {
    el.loopBand.hidden = true;
    return;
  }
  const last = Math.max(1, state.fmap.lastFrame);
  const a = Math.min(loopA, loopB) / last;
  const b = Math.max(loopA, loopB) / last;
  el.loopBand.hidden = false;
  el.loopBand.style.left = `${a * 100}%`;
  el.loopBand.style.width = `${Math.max(0.4, (b - a) * 100)}%`;
}

/* ------------------------------------------------------------------ *
 * Markers
 * ------------------------------------------------------------------ */

function newId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function sortMarkers() {
  state.markers.sort((a, b) => a.frame - b.frame);
}

/** The marker on `frame`, preferring one that already carries text. */
function markerAt(frame) {
  const here = state.markers.filter((m) => m.frame === frame);
  return here.find((m) => m.text) || here[0] || null;
}

function addMarker(marker) {
  state.markers.push(marker);
  sortMarkers();
  renderMarkers();
  saveSoon();
}

function removeMarker(id) {
  state.markers = state.markers.filter((m) => m.id !== id);
  renderMarkers();
  saveSoon();
}

/**
 * Star the current frame. A frame holds at most one marker, so this flips the
 * kind of whatever is already there instead of stacking a second entry:
 * nothing → bookmark, note → bookmark, bookmark with text → back to a note,
 * bookmark without text → gone.
 */
function toggleBookmark() {
  if (!loaded()) return;
  const existing = markerAt(state.cursor);
  if (!existing) {
    addMarker({
      id: newId(), frame: state.cursor, kind: 'bookmark', text: '', color: noteColor,
    });
    toast(`즐겨찾기 추가 (프레임 ${state.cursor})`);
  } else if (existing.kind === 'bookmark') {
    if (existing.text) {
      existing.kind = 'note';
      renderMarkers();
      saveSoon();
      toast(`즐겨찾기 해제 (메모는 유지)`);
    } else {
      removeMarker(existing.id);
      toast(`즐겨찾기 해제 (프레임 ${state.cursor})`);
    }
  } else {
    existing.kind = 'bookmark';
    renderMarkers();
    saveSoon();
    toast(`즐겨찾기 추가 (프레임 ${state.cursor})`);
  }
  syncNote(true);
}

/* ------------------------------------------------------------------ *
 * Note bar
 *
 * The textarea is bound to whatever frame the cursor sits on. Edits commit on
 * a short debounce, and any pending edit is flushed before the frame changes,
 * so stepping away from a half-typed note never loses it.
 * ------------------------------------------------------------------ */

const NOTEBAR_KEY = 'chodani.notebarCollapsed';

let noteColor = MARKER_COLORS[0];
/** Frame the textarea currently represents; null before any media is open. */
let noteFrame = null;
let noteTimer = null;

function renderColorChips() {
  el.noteColors.innerHTML = '';
  for (const color of MARKER_COLORS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'color-chip';
    chip.style.background = color;
    chip.classList.toggle('is-active', color === noteColor);
    chip.title = '메모 색';
    chip.addEventListener('click', () => {
      noteColor = color;
      renderColorChips();
      const marker = markerAt(noteFrame ?? state.cursor);
      if (marker) {
        marker.color = color;
        renderMarkers();
        saveSoon();
      }
    });
    el.noteColors.appendChild(chip);
  }
}

/** Write the textarea's contents back onto `frame`, creating or removing as needed. */
function commitNote(frame) {
  if (frame === null || !loaded()) return;
  const text = el.noteInline.value.trim();
  const existing = markerAt(frame);

  if (!text) {
    // A starred frame keeps its star when the text is cleared.
    if (!existing) return;
    if (existing.kind === 'bookmark') {
      if (!existing.text) return;
      existing.text = '';
      renderMarkers();
      saveSoon();
    } else {
      removeMarker(existing.id);
    }
  } else if (existing) {
    if (existing.text === text && existing.color === noteColor) return;
    existing.text = text;
    existing.color = noteColor;
    renderMarkers();
    saveSoon();
  } else {
    addMarker({ id: newId(), frame, kind: 'note', text, color: noteColor });
  }
  el.noteState.textContent = text ? '저장됨' : '';
}

function flushNote() {
  clearTimeout(noteTimer);
  noteTimer = null;
  commitNote(noteFrame);
}

/** Point the textarea at the current frame. No-op while playing back. */
function syncNote(force = false) {
  if (!loaded()) return;
  if (state.playing && !force) return;
  const frame = state.cursor;
  if (frame === noteFrame && !force) return;

  if (frame !== noteFrame) flushNote();
  noteFrame = frame;

  // Reaching here means the frame really changed (or a forced refresh), so the
  // textarea is repointed even while focused — that is what Alt+arrows are for.
  const marker = markerAt(frame);
  el.noteInline.value = marker?.text ?? '';
  if (marker) noteColor = marker.color;
  renderColorChips();
  el.noteFrameLabel.textContent = String(frame);
  el.noteState.textContent = marker?.text ? '저장됨' : '';
}

function focusNote() {
  if (!loaded()) return;
  el.notebar.classList.remove('is-collapsed');
  localStorage.setItem(NOTEBAR_KEY, '0');
  syncNote(true);
  el.noteInline.focus();
  el.noteInline.setSelectionRange(el.noteInline.value.length, el.noteInline.value.length);
}

el.noteInline.addEventListener('input', () => {
  el.noteState.textContent = '입력 중…';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => commitNote(noteFrame), 400);
});
el.noteInline.addEventListener('blur', flushNote);

$('btn-note-clear').addEventListener('click', () => {
  el.noteInline.value = '';
  flushNote();
  syncNote(true);
});

$('notebar-toggle').addEventListener('click', () => {
  const collapsed = el.notebar.classList.toggle('is-collapsed');
  localStorage.setItem(NOTEBAR_KEY, collapsed ? '1' : '0');
});
if (localStorage.getItem(NOTEBAR_KEY) === '1') el.notebar.classList.add('is-collapsed');
renderColorChips();

function renderMarkers() {
  const query = el.markerFilter.value.trim().toLowerCase();
  const visible = query
    ? state.markers.filter((m) => m.text.toLowerCase().includes(query) || String(m.frame).includes(query))
    : state.markers;

  el.markerList.innerHTML = '';
  el.markerEmpty.hidden = visible.length > 0;

  for (const m of visible) {
    const li = document.createElement('li');
    li.className = 'marker-item';
    li.dataset.id = m.id;
    li.dataset.frame = String(m.frame);

    const swatch = document.createElement('div');
    swatch.className = 'marker-swatch';
    swatch.style.background = m.color;

    const body = document.createElement('div');
    body.className = 'marker-body';
    const head = document.createElement('div');
    head.innerHTML = `<span class="marker-frame">${m.kind === 'bookmark' ? '★ ' : '✎ '}${m.frame}</span>`
      + `<span class="marker-time">${loaded() ? state.fmap.timecodeOf(m.frame) : ''}</span>`;
    body.appendChild(head);
    if (m.text) {
      const p = document.createElement('p');
      p.className = 'marker-text';
      p.textContent = m.text;
      body.appendChild(p);
    }

    const actions = document.createElement('div');
    actions.className = 'marker-actions';
    const edit = document.createElement('button');
    edit.className = 'icon-btn';
    edit.innerHTML = '<svg><use href="#i-edit"/></svg>';
    edit.title = '메모 수정';
    edit.addEventListener('click', (e) => { e.stopPropagation(); goToFrame(m.frame); focusNote(); });
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.innerHTML = '<svg><use href="#i-x"/></svg>';
    del.title = '삭제';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeMarker(m.id); });
    actions.append(edit, del);

    li.append(swatch, body, actions);
    li.addEventListener('click', () => goToFrame(m.frame));
    el.markerList.appendChild(li);
  }

  renderTicks();
  highlightMarker(state.cursor);
}

function renderTicks() {
  el.markerLane.innerHTML = '';
  if (!loaded()) return;
  const last = Math.max(1, state.fmap.lastFrame);
  for (const m of state.markers) {
    const tick = document.createElement('div');
    tick.className = `marker-tick${m.kind === 'note' ? ' is-note' : ''}`;
    tick.style.left = `${(m.frame / last) * 100}%`;
    tick.style.background = m.color;
    tick.title = `${m.frame}${m.text ? ` — ${m.text}` : ''}`;
    tick.addEventListener('pointerdown', (e) => { e.stopPropagation(); goToFrame(m.frame); });
    el.markerLane.appendChild(tick);
  }
}

function highlightMarker(frame) {
  for (const li of el.markerList.children) {
    li.classList.toggle('is-current', Number(li.dataset.frame) === frame);
  }
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function projectPayload() {
  return {
    version: 1,
    fps: state.fmap ? state.fmap.fps : null,
    frame_count: state.fmap ? state.fmap.count : null,
    markers: state.markers,
    loop: { a: state.loopA, b: state.loopB, enabled: state.looping },
    last_frame: state.cursor,
  };
}

function saveSoon() {
  if (!state.info) return;
  el.saveState.textContent = '저장 중…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      await invoke('save_project', {
        origin: state.info.origin,
        title: state.info.title,
        kind: state.info.kind,
        data: projectPayload(),
      });
      el.saveState.textContent = '저장됨';
    } catch (e) {
      el.saveState.textContent = '';
      toast(`저장 실패: ${e}`, true);
    }
  }, 400);
}

function applyProject(data) {
  if (!data) return;
  state.markers = Array.isArray(data.markers) ? data.markers : [];
  sortMarkers();
  const loop = data.loop || {};
  state.loopA = Number.isInteger(loop.a) ? loop.a : null;
  state.loopB = Number.isInteger(loop.b) ? loop.b : null;
  state.looping = !!loop.enabled && state.loopA !== null && state.loopB !== null;
  el.btnLoop.classList.toggle('is-on', state.looping);
  renderMarkers();
  renderLoopBand();
  if (Number.isInteger(data.last_frame)) goToFrame(data.last_frame);
  syncNote(true);
}

/* ------------------------------------------------------------------ *
 * Opening media
 * ------------------------------------------------------------------ */

async function mount(info) {
  // Swapping the source under a running play() aborts it too, so stand the
  // player down first and retire any request still in flight.
  playIntent += 1;
  state.playing = false;
  el.btnPlay.classList.remove('is-playing');
  el.video.pause();

  state.info = info;
  state.fmap = new FrameMap(info);
  state.markers = [];
  noteFrame = null;
  el.noteInline.value = '';
  el.noteInline.disabled = false;
  state.loopA = state.loopB = null;
  state.looping = false;
  state.pinned = null;
  el.btnLoop.classList.remove('is-on');
  el.compareMode.value = 'off';
  clearCache();
  clearOverlays();
  renderCompare();
  resetView();

  const url = await invoke('playback_url', { kind: info.kind, serve: info.serve });
  helperReady = false;
  el.video.src = url;
  helper.src = url;

  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('이 영상을 재생할 수 없습니다.')); };
    const cleanup = () => {
      el.video.removeEventListener('loadeddata', ok);
      el.video.removeEventListener('error', bad);
    };
    el.video.addEventListener('loadeddata', ok);
    el.video.addEventListener('error', bad);
  });

  if (helper.readyState >= 2) helperReady = true;
  else helper.addEventListener('loadeddata', () => { helperReady = true; }, { once: true });

  el.dropHint.hidden = true;
  el.video.playbackRate = Number(el.speed.value);
  if (info.variable_frame_rate && info.kind === 'file') await buildIndex();
  renderMeta();
  renderMarkers();
  renderLoopBand();
  goToFrame(0);

  const saved = await invoke('load_project', { origin: info.origin }).catch(() => null);
  applyProject(saved);
  refreshRecent();
}

/**
 * Replace the n / fps estimate with every frame's real presentation time.
 *
 * Only worth doing when the timestamps are uneven — for a constant-rate file
 * the index reproduces n / fps exactly, so it would cost a full packet scan to
 * learn nothing. Runs silently as part of opening: a stale frame number is not
 * something the user could notice or act on, so it is not something to ask
 * about.
 */
async function buildIndex() {
  if (!state.info) return;
  try {
    const times = await invoke('frame_index', { kind: state.info.kind, serve: state.info.serve });
    state.fmap.setIndex(times);
  } catch (e) {
    // The estimate stays in place; it is close enough to keep working with.
    console.warn('frame index unavailable:', e);
  }
}

async function openPath(path) {
  busy('영상을 여는 중…', true);
  try {
    const info = await invoke('open_local', { path });
    await mount(info);
    toast(`${info.title} 열림`);
  } catch (e) {
    toast(String(e), true);
  } finally {
    busyDone();
  }
}

async function openUrl(rawUrl) {
  const url = rawUrl.trim();
  if (!url) return;
  const maxHeight = Number(el.streamHeight.value);
  const download = el.streamDownload.checked;
  busy(download ? '영상을 내려받는 중…' : '링크를 해석하는 중…', download);
  try {
    const info = download
      ? await invoke('download_stream', { url, maxHeight })
      : await invoke('open_stream', { url, quality: el.streamQuality.value, maxHeight });
    await mount(info);
    el.urlInput.value = '';
    toast(`${info.title} 열림`);
  } catch (e) {
    const message = String(e);
    if (message.includes('yt-dlp')) {
      toast('yt-dlp가 필요합니다. "최근" 탭에서 설치하세요.', true);
    } else {
      toast(message, true);
    }
  } finally {
    busyDone();
  }
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function currentFrameDataUrl() {
  const canvas = document.createElement('canvas');
  canvas.width = el.video.videoWidth;
  canvas.height = el.video.videoHeight;
  canvas.getContext('2d').drawImage(el.video, 0, 0);
  return canvas.toDataURL('image/png');
}

function safeName(text) {
  return text.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

async function exportCurrentFrame() {
  if (!loaded()) return;
  const suggested = `${safeName(state.info.title)}_f${String(state.cursor).padStart(5, '0')}.png`;
  const path = asPath(await dialog.save({
    title: '프레임 저장',
    defaultPath: suggested,
    filters: [{ name: 'PNG 이미지', extensions: ['png'] }],
  }));
  if (!path) return;
  try {
    await invoke('save_image', { path, dataUrl: currentFrameDataUrl() });
    toast('PNG 저장 완료');
  } catch (e) {
    toast(String(e), true);
  }
}

async function exportAllMarkers() {
  if (!loaded() || state.markers.length === 0) {
    toast('내보낼 마커가 없습니다.');
    return;
  }
  const dir = asPath(await dialog.open({ title: '저장할 폴더 선택', directory: true }));
  if (!dir) return;

  const resume = state.cursor;
  busy('마커 프레임을 저장하는 중…', true);
  try {
    for (let i = 0; i < state.markers.length; i += 1) {
      const m = state.markers[i];
      await seekAndSettle(m.frame);
      const label = m.text ? `_${safeName(m.text.split('\n')[0])}` : '';
      const name = `${safeName(state.info.title)}_f${String(m.frame).padStart(5, '0')}${label}.png`;
      await invoke('save_image', { path: `${dir}\\${name}`, dataUrl: currentFrameDataUrl() });
      busyProgress((i + 1) / state.markers.length);
    }
    toast(`${state.markers.length}개 프레임을 저장했습니다.`);
  } catch (e) {
    toast(String(e), true);
  } finally {
    busyDone();
    goToFrame(resume);
  }
}

/** Seek and wait until the decoder has actually presented that frame. */
function seekAndSettle(frame) {
  return new Promise((resolve) => {
    goToFrame(frame);
    const check = () => {
      if (!state.seeking && state.pending === null) {
        requestAnimationFrame(resolve);
        return;
      }
      setTimeout(check, 16);
    };
    check();
  });
}

/* ------------------------------------------------------------------ *
 * Sidebar: recent + tools
 * ------------------------------------------------------------------ */

async function refreshRecent() {
  const entries = await invoke('recent_projects').catch(() => []);
  el.recentList.innerHTML = '';
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'recent-item';
    const body = document.createElement('div');
    body.className = 'recent-body';
    body.innerHTML = `<div class="recent-title">${escapeHtml(entry.title)}</div>`
      + `<div class="recent-sub">마커 ${entry.marker_count}개 · ${entry.kind === 'url' ? '링크' : '파일'}</div>`;
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.innerHTML = '<svg><use href="#i-x"/></svg>';
    del.title = '목록에서 제거';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await invoke('forget_project', { origin: entry.origin });
      refreshRecent();
    });
    li.append(body, del);
    li.addEventListener('click', () => {
      if (entry.kind === 'url') openUrl(entry.origin);
      else openPath(entry.origin);
    });
    el.recentList.appendChild(li);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function refreshTools() {
  const status = await invoke('tool_status');
  const rows = [
    ['ffmpeg', status.ffmpeg, '영상 변환 (GIF · MKV 등)'],
    ['ffprobe', status.ffprobe, '프레임 정보 분석'],
    ['yt-dlp', status.ytdlp, '링크 불러오기'],
  ];
  el.toolStatus.innerHTML = '';
  for (const [name, ok, why] of rows) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot${ok ? ' ok' : ''}"></span><b>${name}</b> — ${why}`;
    el.toolStatus.appendChild(li);
  }
  $('btn-install-ytdlp').hidden = status.ytdlp;
  $('btn-open-cache').onclick = () => invoke('reveal', { path: status.cache_dir });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

$('btn-open').addEventListener('click', async () => {
  const path = asPath(await dialog.open({ title: '영상 열기', filters: [VIDEO_FILTER] }));
  if (path) openPath(path);
});

$('btn-load-url').addEventListener('click', () => openUrl(el.urlInput.value));
el.urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') openUrl(el.urlInput.value);
});

$('btn-first').addEventListener('click', () => goToFrame(0));
$('btn-last').addEventListener('click', () => goToFrame(state.fmap?.lastFrame ?? 0));
$('btn-back-1').addEventListener('click', () => step(-1));
$('btn-fwd-1').addEventListener('click', () => step(1));
$('btn-back-n').addEventListener('click', () => step(-stepSize()));
$('btn-fwd-n').addEventListener('click', () => step(stepSize()));
el.btnPlay.addEventListener('click', () => setPlaying(!state.playing));

function stepSize() {
  return Math.max(1, Number(el.stepSize.value) || 1);
}

el.speed.addEventListener('change', () => { el.video.playbackRate = Number(el.speed.value); });

el.frameInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  goToFrame(Number(el.frameInput.value));
  el.frameInput.blur();
});
el.frameInput.addEventListener('blur', renderReadout);

el.btnLoop.addEventListener('click', () => {
  if (state.loopA === null || state.loopB === null) {
    toast('먼저 A와 B 지점을 지정하세요.');
    return;
  }
  state.looping = !state.looping;
  el.btnLoop.classList.toggle('is-on', state.looping);
  saveSoon();
});
$('btn-mark-in').addEventListener('click', () => {
  state.loopA = state.cursor;
  if (state.loopB !== null && state.loopB <= state.loopA) state.loopB = null;
  renderLoopBand();
  saveSoon();
  toast(`반복 시작 = ${state.cursor}`);
});
$('btn-mark-out').addEventListener('click', () => {
  state.loopB = state.cursor;
  if (state.loopA !== null && state.loopA >= state.loopB) state.loopA = null;
  renderLoopBand();
  saveSoon();
  toast(`반복 끝 = ${state.cursor}`);
});
$('btn-clear-loop').addEventListener('click', () => {
  state.loopA = state.loopB = null;
  state.looping = false;
  el.btnLoop.classList.remove('is-on');
  renderLoopBand();
  saveSoon();
});

$('btn-bookmark').addEventListener('click', toggleBookmark);
$('btn-export').addEventListener('click', exportCurrentFrame);
$('btn-export-marks').addEventListener('click', exportAllMarkers);
el.markerFilter.addEventListener('input', renderMarkers);

$('btn-export-json').addEventListener('click', async () => {
  if (!state.info) return;
  const path = asPath(await dialog.save({
    title: '마커 내보내기',
    defaultPath: `${safeName(state.info.title)}.chodani.json`,
    filters: [{ name: 'Chodani 프로젝트', extensions: ['json'] }],
  }));
  if (!path) return;
  await invoke('export_project', { path, data: projectPayload() });
  toast('내보내기 완료');
});

$('btn-import').addEventListener('click', async () => {
  const path = asPath(await dialog.open({
    title: '마커 가져오기',
    filters: [{ name: 'Chodani 프로젝트', extensions: ['json'] }],
  }));
  if (!path) return;
  try {
    applyProject(await invoke('import_project', { path }));
    saveSoon();
    toast('가져오기 완료');
  } catch (e) {
    toast(String(e), true);
  }
});

$('btn-install-ytdlp').addEventListener('click', async () => {
  busy('yt-dlp를 내려받는 중…');
  try {
    await invoke('install_ytdlp');
    toast('yt-dlp 설치 완료');
    refreshTools();
  } catch (e) {
    toast(String(e), true);
  } finally {
    busyDone();
  }
});

for (const control of [el.onionOn, el.onionGap, el.onionPrevOp, el.onionNextOp, el.onionBlend, el.onionTint]) {
  control.addEventListener('input', scheduleOverlays);
}
el.compareMode.addEventListener('change', renderCompare);
el.pinOpacity.addEventListener('input', renderCompare);
$('btn-pin').addEventListener('click', pinCurrent);
$('btn-unpin').addEventListener('click', unpin);
$('btn-fit').addEventListener('click', resetView);
$('btn-zoom-reset').addEventListener('click', resetView);

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t === tab);
    for (const p of document.querySelectorAll('.tab-panel')) {
      p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
    }
  });
}

el.video.addEventListener('seeked', onSeeked);
el.video.addEventListener('progress', renderBuffered);
el.video.addEventListener('ended', () => setPlaying(false));
el.video.addEventListener('pause', () => {
  if (state.playing) setPlaying(false);
});

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

const SHORTCUTS = [
  ['Space', '재생 / 정지'],
  ['← →  또는  , .', '1프레임 이동'],
  ['Shift + ← →', 'N프레임 이동'],
  ['Ctrl + ← →', '1초 이동'],
  ['Home / End', '처음 / 끝'],
  ['M', '메모 칸으로 이동'],
  ['B', '즐겨찾기 토글'],
  ['I / O', '반복 A / B 지정'],
  ['L', '구간 반복 켜기·끄기'],
  ['N', '어니언 스킨'],
  ['P', '현재 프레임 고정'],
  ['\\ (누르는 동안)', '고정 프레임 겹쳐보기'],
  ['E', '현재 프레임 PNG 저장'],
  ['Alt + ← →', '메모를 쓰면서 프레임 이동'],
  ['Esc', '메모 칸에서 빠져나가기'],
  ['[ / ]', '스텝 크기 조절'],
  ['0', '확대 초기화'],
  ['1 … 9', 'n번째 마커로 이동'],
];

function typing(e) {
  const tag = e.target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
    if (!typing(e)) { e.preventDefault(); el.helpDialog.showModal(); }
    return;
  }
  if (el.helpDialog.open || $('update-dialog').open) return;
  if (!loaded()) return;

  const big = e.ctrlKey ? Math.round(state.fmap.fps) : (e.shiftKey ? stepSize() : 1);

  if (typing(e)) {
    // Alt+arrows still step frames while the caret is in the note box — the
    // whole point of the note bar is annotating as you walk through frames.
    if (e.target === el.noteInline && e.altKey && e.key.startsWith('Arrow')) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        step(e.key === 'ArrowLeft' ? -big : big);
      }
    } else if (e.key === 'Escape' && e.target === el.noteInline) {
      el.noteInline.blur();
    }
    return;
  }

  switch (e.key) {
    case ' ': e.preventDefault(); setPlaying(!state.playing); break;
    case 'ArrowLeft': case ',': e.preventDefault(); step(-big); break;
    case 'ArrowRight': case '.': e.preventDefault(); step(big); break;
    case 'Home': e.preventDefault(); goToFrame(0); break;
    case 'End': e.preventDefault(); goToFrame(state.fmap.lastFrame); break;
    case 'm': case 'M': case 'ㅡ': e.preventDefault(); focusNote(); break;
    case 'b': case 'B': e.preventDefault(); toggleBookmark(); break;
    case 'i': case 'I': $('btn-mark-in').click(); break;
    case 'o': case 'O': $('btn-mark-out').click(); break;
    case 'l': case 'L': el.btnLoop.click(); break;
    case 'n': case 'N':
      el.onionOn.checked = !el.onionOn.checked;
      scheduleOverlays();
      toast(`어니언 스킨 ${el.onionOn.checked ? '켜짐' : '꺼짐'}`);
      break;
    case 'p': case 'P': pinCurrent(); break;
    case 'e': case 'E': exportCurrentFrame(); break;
    case '[': el.stepSize.value = String(Math.max(1, stepSize() - 1)); break;
    case ']': el.stepSize.value = String(Math.min(999, stepSize() + 1)); break;
    case '0': resetView(); break;
    case '\\':
      if (state.pinned && !e.repeat) {
        el.pinOverlay.style.opacity = '1';
        paint(el.pinOverlay, state.pinned.bitmap, null);
      }
      break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        const m = state.markers[Number(e.key) - 1];
        if (m) goToFrame(m.frame);
      }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === '\\') renderCompare();
});

/* ------------------------------------------------------------------ *
 * Updates (GitHub Releases via tauri-plugin-updater)
 * ------------------------------------------------------------------ */

const AUTO_UPDATE_KEY = 'chodani.autoUpdateCheck';

/** Metadata for the pending update, held between check and install. */
let availableUpdate = null;

function setUpdateStatus(text) {
  $('update-status').textContent = text;
}

/**
 * @param {boolean} manual  Whether the user asked. Silent checks stay quiet on
 *   failure — being offline should not throw a dialog at somebody.
 */
async function checkForUpdate(manual) {
  const button = $('btn-check-update');
  button.disabled = true;
  setUpdateStatus('확인 중…');
  try {
    const meta = await invoke('plugin:updater|check', { timeout: 20000 });
    if (!meta) {
      availableUpdate = null;
      $('btn-update-badge').hidden = true;
      setUpdateStatus('최신 버전입니다.');
      if (manual) toast('이미 최신 버전입니다.');
      return;
    }
    availableUpdate = meta;
    $('btn-update-badge').hidden = false;
    $('btn-update-badge').textContent = `업데이트 v${meta.version}`;
    setUpdateStatus(`새 버전 v${meta.version} 사용 가능`);
    showUpdateDialog();
  } catch (e) {
    setUpdateStatus(manual ? `확인 실패: ${e}` : '');
    if (manual) toast(`업데이트 확인 실패: ${e}`, true);
  } finally {
    button.disabled = false;
  }
}

function showUpdateDialog() {
  if (!availableUpdate) return;
  const { version, currentVersion, date, body } = availableUpdate;
  $('update-versions').textContent =
    `v${currentVersion} → v${version}${date ? ` · ${date.slice(0, 10)}` : ''}`;
  $('update-notes').textContent = (body || '').trim() || '변경 내용이 제공되지 않았습니다.';
  $('update-dialog').showModal();
}

async function installUpdate() {
  if (!availableUpdate) return;
  busy('업데이트를 내려받는 중…', true);
  let downloaded = 0;
  let total = 0;
  const channel = new Channel();
  channel.onmessage = (message) => {
    if (message.event === 'Started') {
      total = message.data?.contentLength || 0;
    } else if (message.event === 'Progress') {
      downloaded += message.data?.chunkLength || 0;
      if (total > 0) busyProgress(downloaded / total);
    } else if (message.event === 'Finished') {
      busyProgress(1);
      busyText('설치하고 재시작하는 중…');
    }
  };
  try {
    await invoke('plugin:updater|download_and_install', {
      rid: availableUpdate.rid,
      onEvent: channel,
      restartAfterInstall: false,
    });
    // The installer has been staged; restarting hands over to it.
    await invoke('plugin:process|restart');
  } catch (e) {
    busyDone();
    toast(`업데이트 실패: ${e}`, true);
  }
}

$('btn-update-badge').addEventListener('click', showUpdateDialog);
$('btn-check-update').addEventListener('click', () => checkForUpdate(true));
$('update-dialog').addEventListener('close', () => {
  if ($('update-dialog').returnValue === 'install') installUpdate();
});
$('auto-update-check').addEventListener('change', (e) => {
  localStorage.setItem(AUTO_UPDATE_KEY, e.target.checked ? '1' : '0');
});

async function initUpdates() {
  try {
    const version = await invoke('plugin:app|version');
    $('app-version').textContent = `Chodani v${version}`;
  } catch { /* not fatal */ }

  const auto = localStorage.getItem(AUTO_UPDATE_KEY) !== '0';
  $('auto-update-check').checked = auto;
  if (auto) checkForUpdate(false);
}

/* ------------------------------------------------------------------ *
 * Drag & drop + startup
 * ------------------------------------------------------------------ */

listen('tauri://drag-enter', () => el.stage.classList.add('is-dropping'));
listen('tauri://drag-leave', () => el.stage.classList.remove('is-dropping'));
listen('tauri://drag-drop', (e) => {
  el.stage.classList.remove('is-dropping');
  const path = e.payload?.paths?.[0];
  if (path) openPath(path);
});
listen('convert-progress', (e) => {
  busyText('영상을 변환하는 중…');
  busyProgress(Number(e.payload) || 0);
});

function busyText(text) {
  el.busyText.textContent = text;
  el.busyBar.parentElement.hidden = false;
}

function buildHelp() {
  el.helpGrid.innerHTML = '';
  for (const [key, description] of SHORTCUTS) {
    const k = document.createElement('kbd');
    k.textContent = key;
    const d = document.createElement('span');
    d.textContent = description;
    el.helpGrid.append(k, d);
  }
}

$('btn-help').addEventListener('click', () => el.helpDialog.showModal());

if (hasRVFC) el.video.requestVideoFrameCallback(onPresented);
else requestAnimationFrame(pollFallback);

buildHelp();
refreshTools();
refreshRecent();
initUpdates();
invoke('startup_file').then((path) => { if (path) openPath(path); }).catch(() => {});
