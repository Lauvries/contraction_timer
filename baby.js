import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { addSecondSide, deleteAllFeedsForUser, deleteFeed, insertFeed, pullFeeds, subscribeFeedsRealtime, updateFeed } from "./feeds.js";

const syncStatusEl = document.getElementById("syncStatus");
const signOutBtn = document.getElementById("signOutBtn");
const reloadBtn = document.getElementById("reloadBtn");

const DEBUG_STATE_KEY = "baby_debug_state_v1";
const FEED_STATE_KEY = "baby_feed_state_v1";
const MAX_DEBUG_LOGS = 250;

const loginDialog = document.getElementById("loginDialog");
const loginForm = document.getElementById("loginForm");
const loginEmailInput = document.getElementById("loginEmail");
const loginPasswordInput = document.getElementById("loginPassword");
const loginErrorEl = document.getElementById("loginError");
const loginSubmitBtn = document.getElementById("loginSubmit");

const feedLeftBtn = document.getElementById("feedLeft");
const feedRightBtn = document.getElementById("feedRight");
const feedLeftText = document.getElementById("feedLeftText");
const feedRightText = document.getElementById("feedRightText");
const feedLeftIcon = document.getElementById("feedLeftIcon");
const feedRightIcon = document.getElementById("feedRightIcon");
const feedStopMidBtn = document.getElementById("feedStopMid");

const feedTimeSinceEl = document.getElementById("feedTimeSince");
const feedTimeToEl = document.getElementById("feedTimeTo");
const feedTimeToHint = document.getElementById("feedTimeToHint");

const feedsListEl = document.getElementById("feedsList");
const feedsEmptyEl = document.getElementById("feedsEmpty");
const feedsPrevPageBtn = document.getElementById("feedsPrevPage");
const feedsNextPageBtn = document.getElementById("feedsNextPage");
const feedsPageLabel = document.getElementById("feedsPageLabel");
const feedsClearAllBtn = document.getElementById("feedsClearAllBtn");

const FEEDS_PAGE_SIZE = 20;
let feedsPage = 0;

/** @type {string | null} */
let editingFeedTimeId = null;
/** @type {string | null} */
let editingFeedDurationId = null;
/** @type {"side1" | "side2" | "side2_add" | null} */
let editingFeedDurationSide = null;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {import("./feeds.js").FeedRow[]} */
let feeds = [];
/** @type {null | (() => void)} */
let feedsUnsub = null;

/** @type {string | null} */
let editingExistingFeedId = null;

/** @type {null | { side: "L" | "R", startedWallMs: number, pausedAtWallMs: number | null, pausedTotalMs: number }} */
let active = null;
/** @type {{ L: number, R: number }} */
let accumMs = { L: 0, R: 0 };
/** @type {number | null} */
let sessionStartedAtMs = null;
/** @type {"L" | "R" | null} */
let sessionFirstSide = null;
/** @type {{ L: number, R: number }} */
let lastBeepBucketBySide = { L: 0, R: 0 };
/** @type {"L" | "R" | null} */
let lastFedSideThisSession = null;
/** @type {number | null} */
let tick = null;
/** @type {number | null} */
let metricsTick = null;

const FEED_TARGET_INTERVAL_MS = 3 * 60 * 60 * 1000;
const FEED_BEEP_EVERY_MS = 5 * 60 * 1000;

/** @type {AudioContext | null} */
let audioCtx = null;

function isDebugEnabled() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("debug") === "1") return true;
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(DEBUG_STATE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.enabled);
  } catch {
    return false;
  }
}

function setDebugEnabled(enabled) {
  try {
    localStorage.setItem(DEBUG_STATE_KEY, JSON.stringify({ enabled: Boolean(enabled), updatedAtMs: Date.now() }));
  } catch {
    /* ignore */
  }
}

function pushDebugLog(level, msg, extra) {
  if (!isDebugEnabled()) return;
  try {
    const raw = localStorage.getItem("baby_debug_logs_v1");
    /** @type {any[]} */
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({
      t: Date.now(),
      level,
      msg: String(msg || ""),
      extra: extra == null ? null : extra,
      vis: document.visibilityState,
    });
    while (arr.length > MAX_DEBUG_LOGS) arr.shift();
    localStorage.setItem("baby_debug_logs_v1", JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

function installDebugHooks() {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args) => {
    pushDebugLog("log", args[0], args.slice(1));
    origLog(...args);
  };
  console.warn = (...args) => {
    pushDebugLog("warn", args[0], args.slice(1));
    origWarn(...args);
  };
  console.error = (...args) => {
    pushDebugLog("error", args[0], args.slice(1));
    origErr(...args);
  };

  window.addEventListener("error", (e) => {
    pushDebugLog("window.error", e.message || "error", { filename: e.filename, lineno: e.lineno, colno: e.colno });
  });
  window.addEventListener("unhandledrejection", (e) => {
    pushDebugLog("unhandledrejection", "promise rejection", String(e.reason || ""));
  });

  // Allow copying logs from iOS by running: __babyDebugDump()
  window.__babyDebugDump = () => {
    try {
      return localStorage.getItem("baby_debug_logs_v1") || "[]";
    } catch {
      return "[]";
    }
  };
  window.__babyDebugOn = () => setDebugEnabled(true);
  window.__babyDebugOff = () => setDebugEnabled(false);
}

function getAudioContext() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  return audioCtx;
}

function tryUnlockAudio() {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
}

function beep() {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, now);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.14);
}

function useCloud() {
  const u = String(window.SUPABASE_URL || "").trim();
  const k = String(window.SUPABASE_ANON_KEY || "").trim();
  return u.length > 8 && k.length > 20;
}

function setSyncMessage(text, isError) {
  if (!syncStatusEl) return;
  if (!text) {
    syncStatusEl.hidden = true;
    syncStatusEl.textContent = "";
    return;
  }
  syncStatusEl.hidden = false;
  syncStatusEl.textContent = text;
  syncStatusEl.classList.toggle("sync-status--error", Boolean(isError));
}

function setLoginError(text) {
  if (!loginErrorEl) return;
  if (!text) {
    loginErrorEl.hidden = true;
    loginErrorEl.textContent = "";
    return;
  }
  loginErrorEl.hidden = false;
  loginErrorEl.textContent = text;
}

function showLogin() {
  setLoginError("");
  if (loginDialog && typeof loginDialog.showModal === "function") {
    loginDialog.showModal();
    loginEmailInput?.focus();
  }
}

function hideLoginIfOpen() {
  if (loginDialog && loginDialog.open) loginDialog.close();
}

/** Duration for totals (not clock time): "45s", "3m 12s", "1h 4m 2s". */
function formatDurationSec(sec) {
  let s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  const r = s % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (r > 0 || parts.length === 0) parts.push(`${r}s`);
  return parts.join(" ");
}

function formatElapsed(ms) {
  return formatDurationSec(Math.max(0, Math.floor(ms / 1000)));
}

function formatHoursMinutes(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function formatTimeOnly(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function toTimeInputValue(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function applyTimeStringToStartedAtMs(oldStartedAtMs, timeStr) {
  const m = String(timeStr || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return oldStartedAtMs;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] || "0");
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return oldStartedAtMs;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return oldStartedAtMs;
  const d = new Date(oldStartedAtMs);
  d.setHours(hh, mm, ss, 0);
  return d.getTime();
}

function parseMinSec(minStr, secStr) {
  const mRaw = String(minStr || "").trim();
  const sRaw = String(secStr || "").trim();
  if (mRaw === "" && sRaw === "") return null;
  const m = mRaw === "" ? 0 : Number(mRaw);
  const s = sRaw === "" ? 0 : Number(sRaw);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
  if (!Number.isInteger(m) || !Number.isInteger(s)) return null;
  if (m < 0 || s < 0 || s > 59) return null;
  return m * 60 + s;
}

function computeActiveRunningMs() {
  if (!active) return 0;
  const nowWall = Date.now();
  const endWall = active.pausedAtWallMs == null ? nowWall : active.pausedAtWallMs;
  return Math.max(0, endWall - active.startedWallMs - active.pausedTotalMs);
}

function computeActiveDurationSec() {
  return Math.max(0, Math.round(computeActiveRunningMs() / 1000));
}

function sideTotalMs(side) {
  const base = accumMs[side];
  const extra = active?.side === side ? computeActiveRunningMs() : 0;
  return base + extra;
}

function iconFor(side) {
  const totalMs = sideTotalMs(side);
  if (totalMs <= 0) return "";
  // If this side is active, show the toggle action (pause or resume).
  if (active?.side === side) return active.pausedAtWallMs == null ? "⏸" : "▶";
  // If this side has time but isn't active, show that it can be resumed.
  return "▶";
}

function renderFeedButtons() {
  const activeSide = active?.side ?? null;
  const running = activeSide !== null && active?.pausedAtWallMs == null;
  const paused = activeSide !== null && active?.pausedAtWallMs != null;

  const lMs = sideTotalMs("L");
  const rMs = sideTotalMs("R");
  if (feedLeftText) feedLeftText.textContent = lMs > 0 || activeSide === "L" ? formatElapsed(lMs) : "Left";
  if (feedRightText) feedRightText.textContent = rMs > 0 || activeSide === "R" ? formatElapsed(rMs) : "Right";
  if (feedLeftIcon) feedLeftIcon.textContent = iconFor("L");
  if (feedRightIcon) feedRightIcon.textContent = iconFor("R");

  feedLeftBtn.classList.toggle("is-active", activeSide === "L");
  feedRightBtn.classList.toggle("is-active", activeSide === "R");
  feedLeftBtn.classList.toggle("is-paused", paused && activeSide === "L");
  feedRightBtn.classList.toggle("is-paused", paused && activeSide === "R");

  const lastFedHighlight =
    activeSide ??
    lastFedSideThisSession ??
    (lMs > 0 && rMs <= 0 ? "L" : rMs > 0 && lMs <= 0 ? "R" : null);
  feedLeftBtn.classList.toggle("feeding-last-fed", lastFedHighlight === "L");
  feedRightBtn.classList.toggle("feeding-last-fed", lastFedHighlight === "R");

  if (feedStopMidBtn) feedStopMidBtn.disabled = lMs <= 0 && rMs <= 0 && !activeSide;

  // Beep on each 5-minute boundary for the currently running side.
  if (running && activeSide) {
    const ms = sideTotalMs(activeSide);
    const bucket = Math.floor(ms / FEED_BEEP_EVERY_MS);
    if (bucket > 0 && bucket > lastBeepBucketBySide[activeSide]) {
      lastBeepBucketBySide[activeSide] = bucket;
      beep();
    }
  }
}

function updateTick() {
  if (!active) return;
  renderFeedButtons();
}

function persistFeedFlowState() {
  try {
    const payload = {
      v: 1,
      savedAtMs: Date.now(),
      editingExistingFeedId,
      active,
      accumMs,
      sessionStartedAtMs,
      sessionFirstSide,
      lastFedSideThisSession,
      lastBeepBucketBySide,
    };
    localStorage.setItem(FEED_STATE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function clearPersistedFeedFlowState() {
  try {
    localStorage.removeItem(FEED_STATE_KEY);
  } catch {
    /* ignore */
  }
}

function restoreFeedFlowState() {
  try {
    const raw = localStorage.getItem(FEED_STATE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1) return false;

    editingExistingFeedId = typeof parsed.editingExistingFeedId === "string" ? parsed.editingExistingFeedId : null;

    const nextActive = parsed.active;
    const nextAccum = parsed.accumMs;
    const nextStarted = parsed.sessionStartedAtMs;
    const nextFirst = parsed.sessionFirstSide;
    const nextBuckets = parsed.lastBeepBucketBySide;

    // Validate minimally; fall back to defaults on bad data.
    if (
      nextActive != null &&
      (nextActive.side !== "L" && nextActive.side !== "R")
    ) {
      return false;
    }
    if (nextActive != null) {
      const sw = Number(nextActive.startedWallMs);
      const pt = Number(nextActive.pausedTotalMs);
      const paw = nextActive.pausedAtWallMs == null ? null : Number(nextActive.pausedAtWallMs);
      if (!Number.isFinite(sw) || sw <= 0) return false;
      if (!Number.isFinite(pt) || pt < 0) return false;
      if (paw != null && (!Number.isFinite(paw) || paw <= 0)) return false;
      active = { side: nextActive.side, startedWallMs: sw, pausedAtWallMs: paw, pausedTotalMs: pt };
    } else {
      active = null;
    }

    if (nextAccum && typeof nextAccum === "object") {
      const l = Number(nextAccum.L);
      const r = Number(nextAccum.R);
      accumMs = { L: Number.isFinite(l) && l >= 0 ? l : 0, R: Number.isFinite(r) && r >= 0 ? r : 0 };
    } else {
      accumMs = { L: 0, R: 0 };
    }

    sessionStartedAtMs = typeof nextStarted === "number" && Number.isFinite(nextStarted) ? nextStarted : null;
    sessionFirstSide = nextFirst === "L" || nextFirst === "R" ? nextFirst : null;

    const nextLastFed = parsed.lastFedSideThisSession;
    lastFedSideThisSession = nextLastFed === "L" || nextLastFed === "R" ? nextLastFed : null;

    if (nextBuckets && typeof nextBuckets === "object") {
      const l = Number(nextBuckets.L);
      const r = Number(nextBuckets.R);
      lastBeepBucketBySide = { L: Number.isFinite(l) && l >= 0 ? l : 0, R: Number.isFinite(r) && r >= 0 ? r : 0 };
    } else {
      lastBeepBucketBySide = { L: 0, R: 0 };
    }

    renderFeedButtons();
    if (active && tick == null) tick = window.setInterval(updateTick, 250);
    return true;
  } catch (e) {
    console.warn("Could not restore feed flow state:", e);
    return false;
  }
}

function startSide(side) {
  tryUnlockAudio();
  if (sessionStartedAtMs == null) sessionStartedAtMs = Date.now();
  if (sessionFirstSide == null) sessionFirstSide = side;
  lastFedSideThisSession = side;
  active = {
    side,
    startedWallMs: Date.now(),
    pausedAtWallMs: null,
    pausedTotalMs: 0,
  };
  if (tick != null) clearInterval(tick);
  tick = window.setInterval(updateTick, 250);
  renderFeedButtons();
  persistFeedFlowState();
}

function togglePause() {
  if (!active) return;
  tryUnlockAudio();
  if (active.pausedAtWallMs == null) {
    active.pausedAtWallMs = Date.now();
  } else {
    active.pausedTotalMs += Math.max(0, Date.now() - active.pausedAtWallMs);
    active.pausedAtWallMs = null;
  }
  renderFeedButtons();
  persistFeedFlowState();
}

function pauseRunningSide() {
  if (!active) return;
  lastFedSideThisSession = active.side;
  const ms = computeActiveRunningMs();
  accumMs[active.side] += ms;
  active = null;
  if (tick != null) {
    clearInterval(tick);
    tick = null;
  }
  renderFeedButtons();
  persistFeedFlowState();
}

function activateFeedForEditing(feed) {
  if (!feed) return;
  // If user is in the middle of a different session, confirm switching.
  const hasInFlight = Boolean(active) || accumMs.L > 0 || accumMs.R > 0;
  if (hasInFlight && editingExistingFeedId !== feed.id) {
    if (!confirm("Switch to editing this feed? Your current in-progress timer will be discarded.")) return;
  }

  if (tick != null) {
    clearInterval(tick);
    tick = null;
  }
  active = null;
  accumMs = {
    L: (feed.side1 === "L" ? feed.duration1Sec : feed.duration2Sec || 0) * 1000,
    R: (feed.side1 === "R" ? feed.duration1Sec : feed.duration2Sec || 0) * 1000,
  };
  sessionStartedAtMs = feed.startedAtMs;
  sessionFirstSide = feed.side1;
  lastBeepBucketBySide = { L: 0, R: 0 };
  lastFedSideThisSession = inferLastFedFromFeed(feed);
  editingExistingFeedId = feed.id;
  renderFeedButtons();
  persistFeedFlowState();
}

async function stopActiveAndFinalizeFeed() {
  if (!supabase) {
    setSyncMessage("Not connected to Supabase yet — sign in and refresh.", true);
    return;
  }
  if (!active && accumMs.L === 0 && accumMs.R === 0) return;
  if (tick != null) {
    clearInterval(tick);
    tick = null;
  }

  const lastFedSideAtFinalize = active?.side ?? lastFedSideThisSession ?? null;

  // Stop the currently active side (if any) and finalize totals
  if (active) {
    accumMs[active.side] += computeActiveRunningMs();
    active = null;
  }
  renderFeedButtons();
  persistFeedFlowState();

  const lSec = Math.round(accumMs.L / 1000);
  const rSec = Math.round(accumMs.R / 1000);
  const startedAtMs = sessionStartedAtMs ?? Date.now();

  const { side1, side2, duration1Sec, duration2Sec } = canonicalFeedStorageFromTotals(
    lSec,
    rSec,
    lastFedSideAtFinalize
  );
  const d2 = duration2Sec ?? 0;

  setSyncMessage("Saving…");
  try {
    if (duration1Sec <= 0 && d2 <= 0) {
      setSyncMessage("");
      resetFlow();
      return;
    }

    if (editingExistingFeedId) {
      const id = editingExistingFeedId;
      const target = feeds.find((x) => x.id === id) || null;
      if (!target) throw new Error("Could not find feed to update.");

      await updateFeed(supabase, id, {
        startedAtMs,
        side1,
        side2: d2 > 0 ? side2 : null,
        duration1Sec,
        duration2Sec: d2 > 0 ? d2 : null,
      });

      feeds = feeds.map((f) => {
        if (f.id !== id) return f;
        const next = {
          ...f,
          startedAtMs,
          side1,
          duration1Sec,
          side2: d2 > 0 ? side2 : null,
          duration2Sec: d2 > 0 ? d2 : null,
        };
        delete /** @type {any} */ (next)._uiLastFedSide;
        return next;
      });
    } else {
      if (d2 > 0 && side2) {
        await insertFeed(supabase, { startedAtMs, side1, duration1Sec, side2, duration2Sec: d2 });
      } else {
        await insertFeed(supabase, { startedAtMs, side1, duration1Sec });
      }
    }

    renderFeeds();

    setSyncMessage("");
    resetFlow();
    clearPersistedFeedFlowState();
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not save feed.", true);
  }
}

async function onPressSide(side) {
  if (!active) {
    startSide(side);
    return;
  }
  if (active.side === side) {
    togglePause();
    return;
  }
  // switching sides: PAUSE current boob (do not save), start next
  pauseRunningSide();
  startSide(side);
}

function resetFlow() {
  if (tick != null) {
    clearInterval(tick);
    tick = null;
  }
  active = null;
  accumMs = { L: 0, R: 0 };
  sessionStartedAtMs = null;
  sessionFirstSide = null;
  lastBeepBucketBySide = { L: 0, R: 0 };
  lastFedSideThisSession = null;
  editingExistingFeedId = null;
  renderFeedButtons();
  persistFeedFlowState();
}

function totalDurationSec(feed) {
  return feed.duration1Sec + (feed.duration2Sec || 0);
}

function otherSide(side) {
  return side === "L" ? "R" : "L";
}

/**
 * Map L/R second totals into DB columns. Convention: when both breasts have time, side2 is always
 * the last-fed breast so `inferLastFedFromFeed` matches after sync (no client-only hint).
 *
 * @param {number} lSec
 * @param {number} rSec
 * @param {"L" | "R" | null} lastFedExplicit from active / session (null = infer)
 */
function canonicalFeedStorageFromTotals(lSec, rSec, lastFedExplicit) {
  let lastFed = lastFedExplicit;
  if (lastFed !== "L" && lastFed !== "R") {
    if (lSec > 0 && rSec <= 0) lastFed = "L";
    else if (rSec > 0 && lSec <= 0) lastFed = "R";
    else if (lSec > 0 && rSec > 0) {
      lastFed = otherSide(sessionFirstSide ?? "L");
    } else {
      lastFed = "L";
    }
  }

  if (lSec <= 0 && rSec <= 0) {
    return {
      side1: /** @type {"L"} */ ("L"),
      side2: /** @type {null} */ (null),
      duration1Sec: 0,
      duration2Sec: /** @type {null} */ (null),
    };
  }
  if (rSec <= 0 && lSec > 0) {
    return { side1: "L", side2: null, duration1Sec: lSec, duration2Sec: null };
  }
  if (lSec <= 0 && rSec > 0) {
    return { side1: "R", side2: null, duration1Sec: rSec, duration2Sec: null };
  }
  const first = otherSide(lastFed);
  return {
    side1: first,
    side2: lastFed,
    duration1Sec: first === "L" ? lSec : rSec,
    duration2Sec: lastFed === "L" ? lSec : rSec,
  };
}

/** Last breast for this saved row when second-side duration exists; otherwise side1 only. */
function inferLastFedFromFeed(f) {
  const d2 = f.duration2Sec ?? 0;
  if (d2 > 0 && f.side2) return f.side2;
  return f.side1;
}

function durationSecForBreast(f, side) {
  if (f.side1 === side) return f.duration1Sec;
  if (f.side2 === side) return f.duration2Sec ?? 0;
  return 0;
}

/** Map fixed L/R column to existing side1/side2 editor keys. */
function durationEditKeyForBreast(f, side) {
  if (f.side1 === side) return "side1";
  if (f.side2 === side) return "side2";
  return "side2_add";
}

function lastFeedEndMs() {
  if (feeds.length === 0) return null;
  const f = feeds[0];
  return f.startedAtMs + totalDurationSec(f) * 1000;
}

/** Start time of the most recent feed (used for "next feed at" target window). */
function lastFeedStartMs() {
  if (feeds.length === 0) return null;
  return feeds[0].startedAtMs;
}

function renderFeedingMetrics() {
  if (!feedTimeSinceEl || !feedTimeToEl) return;
  const startMs = lastFeedStartMs();
  const endMs = lastFeedEndMs();
  if (startMs == null || endMs == null) {
    feedTimeSinceEl.textContent = "—";
    feedTimeToEl.textContent = "—";
    feedTimeToEl.classList.remove("feeding-metric-value--overdue");
    if (feedTimeToHint) feedTimeToHint.textContent = "";
    return;
  }

  const sinceMs = Math.max(0, Date.now() - endMs);
  feedTimeSinceEl.textContent = formatElapsed(sinceMs);

  const dueMs = startMs + FEED_TARGET_INTERVAL_MS;
  feedTimeToEl.textContent = formatTimeOnly(dueMs);

  const remainingMs = dueMs - Date.now();
  if (remainingMs <= 0) {
    feedTimeToEl.classList.add("feeding-metric-value--overdue");
    if (feedTimeToHint) feedTimeToHint.textContent = `${formatHoursMinutes(-remainingMs)} overdue`;
  } else {
    feedTimeToEl.classList.remove("feeding-metric-value--overdue");
    if (feedTimeToHint) feedTimeToHint.textContent = `${formatHoursMinutes(remainingMs)} to go`;
  }
}

function renderFeeds() {
  feedsListEl.innerHTML = "";
  feedsEmptyEl.hidden = feeds.length > 0;

  const total = feeds.length;
  const totalPages = total <= 0 ? 0 : Math.ceil(total / FEEDS_PAGE_SIZE);
  if (totalPages <= 0) {
    feedsPage = 0;
  } else {
    feedsPage = Math.max(0, Math.min(feedsPage, totalPages - 1));
  }

  if (feedsPageLabel) {
    feedsPageLabel.textContent = totalPages <= 1 ? "" : `Page ${feedsPage + 1} / ${totalPages}`;
  }
  const feedsPaginationEl = feedsPrevPageBtn?.closest(".feed-pagination");
  if (feedsPaginationEl) feedsPaginationEl.hidden = totalPages <= 1;
  if (feedsPrevPageBtn) feedsPrevPageBtn.disabled = totalPages <= 1 || feedsPage <= 0;
  if (feedsNextPageBtn) feedsNextPageBtn.disabled = totalPages <= 1 || feedsPage >= totalPages - 1;
  if (feedsClearAllBtn) feedsClearAllBtn.hidden = feeds.length === 0;

  const start = feedsPage * FEEDS_PAGE_SIZE;
  const pageFeeds = feeds.slice(start, start + FEEDS_PAGE_SIZE);

  let lastDayKey = null;
  for (const f of pageFeeds) {
    const dayKey = (() => {
      const d = new Date(f.startedAtMs);
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    })();

    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      const d = new Date(f.startedAtMs);
      const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d);
      const sep = document.createElement("li");
      sep.className = "feed-day-sep";
      sep.textContent = `${weekday} · ${dayKey}`;
      feedsListEl.appendChild(sep);
    }

    const li = document.createElement("li");
    li.className = "history-item";

    const rowMeta = document.createElement("div");
    rowMeta.className = "history-item-row history-item-row--meta";

    const totalSec = totalDurationSec(f);
    const totalText = `Total ${formatDurationSec(totalSec)}`;

    if (editingFeedTimeId === f.id) {
      rowMeta.classList.add("history-item-row--edit");
      const wrap = document.createElement("div");
      wrap.className = "history-meta-edit";
      const input = document.createElement("input");
      input.type = "time";
      input.step = "1";
      input.className = "history-time-input";
      input.value = toTimeInputValue(f.startedAtMs);
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "history-pill-btn history-pill-btn--primary";
      apply.textContent = "OK";
      apply.addEventListener("click", async () => {
        editingFeedTimeId = null;
        if (!supabase) return;
        const startedAtMs = applyTimeStringToStartedAtMs(f.startedAtMs, input.value);
        try {
          await updateFeed(supabase, f.id, { startedAtMs });
          setSyncMessage("");
        } catch (e) {
          console.error(e);
          setSyncMessage("Could not update time.", true);
        }
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "history-pill-btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        editingFeedTimeId = null;
        renderFeeds();
      });
      wrap.append(input, apply, cancel);
      rowMeta.appendChild(wrap);
    } else if (editingFeedDurationId === f.id) {
      rowMeta.classList.add("history-item-row--edit");
      const edit = document.createElement("div");
      edit.className = "history-duration-edit-inline";

      const mWrap = document.createElement("div");
      mWrap.className = "history-mini-wrap";
      const minIn = document.createElement("input");
      minIn.type = "number";
      minIn.inputMode = "numeric";
      minIn.min = "0";
      minIn.max = "999";
      minIn.step = "1";
      minIn.className = "history-mini-input";
      minIn.placeholder = "m";
      minIn.setAttribute("aria-label", "Minutes");
      const mLab = document.createElement("span");
      mLab.className = "history-mini-suffix";
      mLab.textContent = "m";

      const sWrap = document.createElement("div");
      sWrap.className = "history-mini-wrap";
      const secIn = document.createElement("input");
      secIn.type = "number";
      secIn.inputMode = "numeric";
      secIn.min = "0";
      secIn.max = "59";
      secIn.step = "1";
      secIn.className = "history-mini-input";
      secIn.placeholder = "s";
      secIn.setAttribute("aria-label", "Seconds");
      const sLab = document.createElement("span");
      sLab.className = "history-mini-suffix";
      sLab.textContent = "s";

      const curSec =
        editingFeedDurationSide === "side2"
          ? (f.duration2Sec || 0)
          : editingFeedDurationSide === "side2_add"
            ? 0
            : f.duration1Sec;
      minIn.value = String(Math.floor(curSec / 60));
      secIn.value = String(curSec % 60);

      const sideHint = document.createElement("span");
      sideHint.className = "feed-edit-side-hint";
      if (editingFeedDurationSide === "side2_add") {
        sideHint.textContent = `Add ${otherSide(f.side1)} duration`;
      } else {
        sideHint.textContent = "";
      }

      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "history-pill-btn history-pill-btn--primary";
      ok.textContent = "OK";
      ok.addEventListener("click", async () => {
        const parsed = parseMinSec(minIn.value, secIn.value);
        if (parsed == null) {
          setSyncMessage("Enter minutes/seconds.", true);
          return;
        }
        editingFeedDurationId = null;
        const sideKey = editingFeedDurationSide;
        editingFeedDurationSide = null;
        if (!supabase || !sideKey) return;
        try {
          if (sideKey === "side1") {
            await updateFeed(supabase, f.id, { duration1Sec: parsed });
          } else if (sideKey === "side2") {
            await updateFeed(supabase, f.id, { duration2Sec: parsed });
          } else if (sideKey === "side2_add") {
            const side2 = otherSide(f.side1);
            await addSecondSide(supabase, f.id, { side2, duration2Sec: parsed });
            // Optimistic update (realtime will also reconcile).
            const i = feeds.findIndex((x) => x.id === f.id);
            if (i !== -1) feeds[i] = { ...feeds[i], side2, duration2Sec: parsed };
          }
          setSyncMessage("");
        } catch (e) {
          console.error(e);
          setSyncMessage("Could not update duration.", true);
        }
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "history-pill-btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        editingFeedDurationId = null;
        editingFeedDurationSide = null;
        renderFeeds();
      });

      mWrap.append(minIn, mLab);
      sWrap.append(secIn, sLab);
      if (editingFeedDurationSide === "side2_add") edit.append(sideHint);
      edit.append(mWrap, sWrap, ok, cancel);
      rowMeta.appendChild(edit);
    } else {
      const timeBtn = document.createElement("button");
      timeBtn.type = "button";
      timeBtn.className = "history-meta-btn history-meta-btn--time";
      timeBtn.textContent = formatTimeOnly(f.startedAtMs);
      timeBtn.setAttribute("aria-label", "Edit time");
      timeBtn.addEventListener("click", () => {
        editingFeedTimeId = f.id;
        editingFeedDurationId = null;
        editingFeedDurationSide = null;
        renderFeeds();
      });

      const sep = document.createElement("span");
      sep.className = "history-meta-sep";
      sep.textContent = "·";
      sep.setAttribute("aria-hidden", "true");

      const lDurSec = durationSecForBreast(f, "L");
      const rDurSec = durationSecForBreast(f, "R");
      const lastFedRow = inferLastFedFromFeed(f);

      const durL = document.createElement("button");
      durL.type = "button";
      durL.className = `history-meta-btn history-meta-btn--dur feed-meta-dur--L${lDurSec <= 0 ? " is-placeholder" : ""}${
        lastFedRow === "L" ? " is-last-fed" : ""
      }`;
      durL.textContent = lDurSec > 0 ? `L: ${formatDurationSec(lDurSec)}` : "—";
      durL.title = lDurSec > 0 ? "Edit L duration" : "Add L duration";
      durL.addEventListener("click", () => {
        editingFeedDurationId = f.id;
        editingFeedDurationSide = durationEditKeyForBreast(f, "L");
        editingFeedTimeId = null;
        renderFeeds();
      });

      const durR = document.createElement("button");
      durR.type = "button";
      durR.className = `history-meta-btn history-meta-btn--dur feed-meta-dur--R${rDurSec <= 0 ? " is-placeholder" : ""}${
        lastFedRow === "R" ? " is-last-fed" : ""
      }`;
      durR.textContent = rDurSec > 0 ? `R: ${formatDurationSec(rDurSec)}` : "—";
      durR.title = rDurSec > 0 ? "Edit R duration" : "Add R duration";
      durR.addEventListener("click", () => {
        editingFeedDurationId = f.id;
        editingFeedDurationSide = durationEditKeyForBreast(f, "R");
        editingFeedTimeId = null;
        renderFeeds();
      });

      rowMeta.classList.add("feed-row-meta");

      const total = document.createElement("span");
      total.className = "feed-total-pill";
      total.textContent = totalText;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "feed-delete-btn";
      del.textContent = "×";
      del.setAttribute("aria-label", "Delete feed");
      del.addEventListener("click", async () => {
        if (!supabase) return;
        if (!confirm("Delete this feed?")) return;
        setSyncMessage("Deleting…");
        try {
          await deleteFeed(supabase, f.id);
          feeds = feeds.filter((x) => x.id !== f.id);
          renderFeeds();
          setSyncMessage("");
        } catch (e) {
          console.error(e);
          setSyncMessage("Could not delete feed.", true);
        }
      });

      const top = document.createElement("div");
      top.className = "feed-meta-top";
      const start = document.createElement("div");
      start.className = "feed-meta-start";
      start.append(timeBtn, sep);
      const actions = document.createElement("div");
      actions.className = "feed-meta-actions";
      actions.append(total, del);
      top.append(start, actions);

      const durations = document.createElement("div");
      durations.className = "feed-meta-durations";
      durations.append(durL, durR);

      rowMeta.append(top, durations);
    }

    li.appendChild(rowMeta);
    feedsListEl.appendChild(li);

    // Tapping the row (not buttons) loads it into the timer to continue.
    if (editingFeedTimeId !== f.id && editingFeedDurationId !== f.id) {
      li.classList.add("is-addable");
      li.addEventListener("click", (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.closest("button")) return;
        activateFeedForEditing(f);
      });
    }
  }
  renderFeedingMetrics();
}

// (state machine moved above)

async function signOut() {
  if (!supabase) return;
  feedsUnsub?.();
  feedsUnsub = null;
  if (metricsTick != null) {
    clearInterval(metricsTick);
    metricsTick = null;
  }
  await supabase.auth.signOut();
  feeds = [];
  if (feedingSummary) feedingSummary.textContent = "";
  renderFeeds();
  signOutBtn.hidden = true;
  setSyncMessage("Sign in to sync your logs.");
  showLogin();
}

async function signInWithPassword() {
  if (!supabase) return;
  const email = loginEmailInput.value.trim();
  const password = loginPasswordInput.value;
  if (!email || !password) {
    setLoginError("Enter email and password.");
    return;
  }
  setLoginError("");
  loginSubmitBtn.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoginError(error.message || "Sign-in failed.");
      return;
    }
    loginPasswordInput.value = "";
    hideLoginIfOpen();
    await onSignedIn();
  } finally {
    loginSubmitBtn.disabled = false;
  }
}

async function onSignedIn() {
  if (!supabase) return;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  signOutBtn.hidden = false;
  setSyncMessage("");
  feeds = await pullFeeds(supabase);
  renderFeeds();
  if (metricsTick != null) clearInterval(metricsTick);
  metricsTick = window.setInterval(renderFeedingMetrics, 1000);
  feedsUnsub?.();
  feedsUnsub = subscribeFeedsRealtime(
    supabase,
    user.id,
    (next) => {
      feeds = next;
      renderFeeds();
    },
    () => feeds,
    setSyncMessage
  );
}

// Event wiring
feedLeftBtn.addEventListener("click", () => {
  try {
    void onPressSide("L");
  } catch (e) {
    console.error(e);
    setSyncMessage("Error on Left tap — check console.", true);
  }
});
feedRightBtn.addEventListener("click", () => {
  try {
    void onPressSide("R");
  } catch (e) {
    console.error(e);
    setSyncMessage("Error on Right tap — check console.", true);
  }
});
feedStopMidBtn?.addEventListener("click", () => void stopActiveAndFinalizeFeed());

feedsPrevPageBtn?.addEventListener("click", () => {
  feedsPage = Math.max(0, feedsPage - 1);
  renderFeeds();
});
feedsNextPageBtn?.addEventListener("click", () => {
  const totalPages = feeds.length <= 0 ? 0 : Math.ceil(feeds.length / FEEDS_PAGE_SIZE);
  feedsPage = Math.min(Math.max(0, totalPages - 1), feedsPage + 1);
  renderFeeds();
});

feedsClearAllBtn?.addEventListener("click", async () => {
  if (!supabase) return;
  if (!confirm("Are you sure you want to delete all feeds? This cannot be undone.")) return;
  setSyncMessage("Deleting…");
  try {
    await deleteAllFeedsForUser(supabase);
    feeds = [];
    feedsPage = 0;
    renderFeeds();
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not delete all feeds.", true);
  }
});

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void signInWithPassword();
});
loginDialog?.addEventListener("cancel", (e) => e.preventDefault());
signOutBtn?.addEventListener("click", () => void signOut());
reloadBtn?.addEventListener("click", () => {
  try {
    pushDebugLog("ui", "reload button clicked");
  } catch {
    /* ignore */
  }
  // In iOS home-screen web apps there is no browser chrome; provide an explicit reload.
  window.location.reload();
});

// Smoke indicator that baby.js booted and handlers attached.
setSyncMessage("");

async function bootstrap() {
  installDebugHooks();
  // Prefer restoring an in-progress timer across reloads/backgrounding.
  const restored = restoreFeedFlowState();
  if (!restored) resetFlow();

  // Keep state fresh when iOS background/foregrounds this PWA.
  const onVisibilityOrFocus = () => {
    persistFeedFlowState();
    if (document.visibilityState === "visible") {
      // Timers may have been suspended; re-arm tick and re-render.
      if (active && tick == null) tick = window.setInterval(updateTick, 250);
      renderFeedButtons();
      renderFeedingMetrics();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityOrFocus);
  window.addEventListener("focus", onVisibilityOrFocus);
  window.addEventListener("pageshow", onVisibilityOrFocus);
  window.addEventListener("pagehide", () => persistFeedFlowState());

  if (!useCloud()) {
    setSyncMessage("Cloud is not configured (supabase-config.js).", true);
    return;
  }

  supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      feedsUnsub?.();
      feedsUnsub = null;
      feeds = [];
      renderFeeds();
      signOutBtn.hidden = true;
      setSyncMessage("Sign in to sync your logs.");
      showLogin();
    }
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.user) {
    await onSignedIn();
  } else {
    setSyncMessage("Sign in to sync your logs.");
    showLogin();
  }
}

void bootstrap();

