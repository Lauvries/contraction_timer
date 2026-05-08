import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { addSecondSide, deleteFeed, insertFeed, pullFeeds, subscribeFeedsRealtime, updateFeed } from "./feeds.js";

const syncStatusEl = document.getElementById("syncStatus");
const signOutBtn = document.getElementById("signOutBtn");

const loginDialog = document.getElementById("loginDialog");
const loginForm = document.getElementById("loginForm");
const loginEmailInput = document.getElementById("loginEmail");
const loginPasswordInput = document.getElementById("loginPassword");
const loginErrorEl = document.getElementById("loginError");
const loginSubmitBtn = document.getElementById("loginSubmit");

const feedLeftBtn = document.getElementById("feedLeft");
const feedRightBtn = document.getElementById("feedRight");
const feedLeftLabel = document.getElementById("feedLeftLabel");
const feedRightLabel = document.getElementById("feedRightLabel");
const feedLeftIcon = document.getElementById("feedLeftIcon");
const feedRightIcon = document.getElementById("feedRightIcon");
const feedStopMidBtn = document.getElementById("feedStopMid");

const feedingSummary = document.getElementById("feedingSummary");
const feedTimeSinceEl = document.getElementById("feedTimeSince");
const feedTimeToEl = document.getElementById("feedTimeTo");
const feedTimeToHint = document.getElementById("feedTimeToHint");

const feedsListEl = document.getElementById("feedsList");
const feedsEmptyEl = document.getElementById("feedsEmpty");

/** @type {string | null} */
let editingFeedTimeId = null;
/** @type {string | null} */
let editingFeedDurationId = null;
/** @type {"side1" | "side2" | null} */
let editingFeedDurationSide = null;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {import("./feeds.js").FeedRow[]} */
let feeds = [];
/** @type {null | (() => void)} */
let feedsUnsub = null;

/** @type {null | { side: "L" | "R", startedPerf: number, startedWallMs: number, pausedAtPerf: number | null, pausedTotalMs: number }} */
let active = null;
/** @type {{ L: number, R: number }} */
let accumMs = { L: 0, R: 0 };
/** @type {number | null} */
let sessionStartedAtMs = null;
/** @type {"L" | "R" | null} */
let sessionFirstSide = null;
/** @type {{ L: number, R: number }} */
let lastBeepBucketBySide = { L: 0, R: 0 };
/** @type {number | null} */
let tick = null;
/** @type {number | null} */
let metricsTick = null;

const FEED_TARGET_INTERVAL_MS = 3 * 60 * 60 * 1000;
const FEED_BEEP_EVERY_MS = 5 * 60 * 1000;

/** @type {AudioContext | null} */
let audioCtx = null;

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

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatHoursMinutes(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function formatDurationSec(sec) {
  return formatElapsed(sec * 1000);
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
  const now = performance.now();
  const end = active.pausedAtPerf == null ? now : active.pausedAtPerf;
  return Math.max(0, end - active.startedPerf - active.pausedTotalMs);
}

function computeActiveDurationSec() {
  return Math.max(0, Math.round(computeActiveRunningMs() / 1000));
}

function iconFor(side) {
  if (!active || active.side !== side) return "";
  // show what will happen if you press again
  return active.pausedAtPerf == null ? "⏸" : "▶";
}

function sideTotalMs(side) {
  const base = accumMs[side];
  const extra = active?.side === side ? computeActiveRunningMs() : 0;
  return base + extra;
}

function renderFeedButtons() {
  const activeSide = active?.side ?? null;
  const running = activeSide !== null && active?.pausedAtPerf == null;
  const paused = activeSide !== null && active?.pausedAtPerf != null;

  const lMs = sideTotalMs("L");
  const rMs = sideTotalMs("R");
  if (feedLeftLabel) feedLeftLabel.textContent = lMs > 0 || activeSide === "L" ? formatElapsed(lMs) : "Left";
  if (feedRightLabel) feedRightLabel.textContent = rMs > 0 || activeSide === "R" ? formatElapsed(rMs) : "Right";
  if (feedLeftIcon) feedLeftIcon.textContent = iconFor("L");
  if (feedRightIcon) feedRightIcon.textContent = iconFor("R");

  feedLeftBtn.classList.toggle("is-active", activeSide === "L");
  feedRightBtn.classList.toggle("is-active", activeSide === "R");
  feedLeftBtn.classList.toggle("is-paused", paused && activeSide === "L");
  feedRightBtn.classList.toggle("is-paused", paused && activeSide === "R");

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

function startSide(side) {
  tryUnlockAudio();
  if (sessionStartedAtMs == null) sessionStartedAtMs = Date.now();
  if (sessionFirstSide == null) sessionFirstSide = side;
  active = {
    side,
    startedPerf: performance.now(),
    startedWallMs: Date.now(),
    pausedAtPerf: null,
    pausedTotalMs: 0,
  };
  if (tick != null) clearInterval(tick);
  tick = window.setInterval(updateTick, 250);
  renderFeedButtons();
}

function togglePause() {
  if (!active) return;
  tryUnlockAudio();
  if (active.pausedAtPerf == null) {
    active.pausedAtPerf = performance.now();
  } else {
    active.pausedTotalMs += Math.max(0, performance.now() - active.pausedAtPerf);
    active.pausedAtPerf = null;
  }
  renderFeedButtons();
}

function pauseRunningSide() {
  if (!active) return;
  const ms = computeActiveRunningMs();
  accumMs[active.side] += ms;
  active = null;
  if (tick != null) {
    clearInterval(tick);
    tick = null;
  }
  renderFeedButtons();
}

function currentSideTotalDurationSec(side) {
  const baseMs = accumMs[side];
  const extraMs = active?.side === side ? computeActiveRunningMs() : 0;
  return Math.max(0, Math.round((baseMs + extraMs) / 1000));
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

  // Stop the currently active side (if any) and finalize totals
  if (active) {
    accumMs[active.side] += computeActiveRunningMs();
    active = null;
  }
  renderFeedButtons();

  const lSec = Math.round(accumMs.L / 1000);
  const rSec = Math.round(accumMs.R / 1000);
  const startedAtMs = sessionStartedAtMs ?? Date.now();
  const first = sessionFirstSide ?? (lSec > 0 ? "L" : "R");

  /** @type {"L"|"R"} */ const side1 = first;
  /** @type {"L"|"R"} */ const side2 = first === "L" ? "R" : "L";
  const duration1Sec = side1 === "L" ? lSec : rSec;
  const duration2Sec = side2 === "L" ? lSec : rSec;

  setSyncMessage("Saving…");
  try {
    if (duration1Sec <= 0 && duration2Sec <= 0) {
      setSyncMessage("");
      resetFlow();
      return;
    }

    if (duration2Sec > 0) {
      await insertFeed(supabase, { startedAtMs, side1, duration1Sec, side2, duration2Sec });
      feedingSummary.textContent = `${side1} ${formatDurationSec(duration1Sec)} + ${side2} ${formatDurationSec(duration2Sec)}`;
    } else {
      await insertFeed(supabase, { startedAtMs, side1, duration1Sec });
      feedingSummary.textContent = `${side1} ${formatDurationSec(duration1Sec)}`;
    }
    setSyncMessage("");
    resetFlow();
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
  renderFeedButtons();
}

function totalDurationSec(feed) {
  return feed.duration1Sec + (feed.duration2Sec || 0);
}

function lastFeedEndMs() {
  if (feeds.length === 0) return null;
  const f = feeds[0];
  return f.startedAtMs + totalDurationSec(f) * 1000;
}

function renderFeedingMetrics() {
  if (!feedTimeSinceEl || !feedTimeToEl) return;
  const endMs = lastFeedEndMs();
  if (endMs == null) {
    feedTimeSinceEl.textContent = "—";
    feedTimeToEl.textContent = "—";
    feedTimeToEl.classList.remove("feeding-metric-value--overdue");
    if (feedTimeToHint) feedTimeToHint.textContent = "";
    return;
  }

  const sinceMs = Math.max(0, Date.now() - endMs);
  feedTimeSinceEl.textContent = formatElapsed(sinceMs);

  const dueMs = endMs + FEED_TARGET_INTERVAL_MS;
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

  for (const f of feeds) {
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

      const curSec = editingFeedDurationSide === "side2" ? (f.duration2Sec || 0) : f.duration1Sec;
      minIn.value = String(Math.floor(curSec / 60));
      secIn.value = String(curSec % 60);

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
          if (sideKey === "side1") await updateFeed(supabase, f.id, { duration1Sec: parsed });
          else await updateFeed(supabase, f.id, { duration2Sec: parsed });
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

      const dur1 = document.createElement("button");
      dur1.type = "button";
      dur1.className = "history-meta-btn history-meta-btn--dur";
      dur1.textContent = `${f.side1}: ${formatDurationSec(f.duration1Sec)}`;
      dur1.title = "Edit duration";
      dur1.addEventListener("click", () => {
        editingFeedDurationId = f.id;
        editingFeedDurationSide = "side1";
        editingFeedTimeId = null;
        renderFeeds();
      });

      const dur2 = document.createElement("button");
      dur2.type = "button";
      dur2.className = `history-meta-btn history-meta-btn--dur${f.side2 ? "" : " is-placeholder"}`;
      dur2.textContent = f.side2 ? `${f.side2}: ${formatDurationSec(f.duration2Sec || 0)}` : "—";
      dur2.title = f.side2 ? "Edit duration" : "No second side";
      dur2.disabled = !f.side2;
      dur2.addEventListener("click", () => {
        if (!f.side2) return;
        editingFeedDurationId = f.id;
        editingFeedDurationSide = "side2";
        editingFeedTimeId = null;
        renderFeeds();
      });

      const spacer = document.createElement("span");
      spacer.className = "history-meta-spacer";

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

      rowMeta.append(timeBtn, sep, dur1, dur2, spacer, total, del);
    }

    li.appendChild(rowMeta);
    feedsListEl.appendChild(li);
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

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void signInWithPassword();
});
loginDialog?.addEventListener("cancel", (e) => e.preventDefault());
signOutBtn?.addEventListener("click", () => void signOut());

// Smoke indicator that baby.js booted and handlers attached.
setSyncMessage("");

async function bootstrap() {
  resetFlow();
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

