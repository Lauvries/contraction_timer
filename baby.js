import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { addSecondSide, deleteFeed, insertFeed, pullFeeds, subscribeFeedsRealtime } from "./feeds.js";

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
const feedPauseBtn = document.getElementById("feedPause");
const feedStopBtn = document.getElementById("feedStop");
const feedAddLeftBtn = document.getElementById("feedAddLeft");
const feedAddRightBtn = document.getElementById("feedAddRight");
const feedDoneBtn = document.getElementById("feedDone");

const feedingStateIdle = document.getElementById("feedingStateIdle");
const feedingStateRunning = document.getElementById("feedingStateRunning");
const feedingStateAfter = document.getElementById("feedingStateAfter");
const feedingRunningWrap = document.getElementById("feedingRunningWrap");
const feedingRunningLabel = document.getElementById("feedingRunningLabel");
const feedingElapsed = document.getElementById("feedingElapsed");
const feedingSummary = document.getElementById("feedingSummary");
const feedTimeSinceEl = document.getElementById("feedTimeSince");
const feedTimeToEl = document.getElementById("feedTimeTo");
const feedTimeToHint = document.getElementById("feedTimeToHint");

const feedsListEl = document.getElementById("feedsList");
const feedsEmptyEl = document.getElementById("feedsEmpty");

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {import("./feeds.js").FeedRow[]} */
let feeds = [];
/** @type {null | (() => void)} */
let feedsUnsub = null;

/** @type {null | { phase: "side1" | "side2", startedPerf: number, startedWallMs: number, side: "L" | "R", pausedAtPerf: number | null, pausedTotalMs: number, feedId?: string, side1DurationSec?: number, side1?: "L" | "R" }} */
let active = null;
/** @type {number | null} */
let tick = null;
/** @type {number | null} */
let metricsTick = null;

const FEED_TARGET_INTERVAL_MS = 3 * 60 * 60 * 1000;

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

function formatDurationSec(sec) {
  return formatElapsed(sec * 1000);
}

function formatTimeOnly(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
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
    return;
  }

  const sinceMs = Math.max(0, Date.now() - endMs);
  feedTimeSinceEl.textContent = formatElapsed(sinceMs);

  const remainingMs = FEED_TARGET_INTERVAL_MS - sinceMs;
  if (remainingMs <= 0) {
    feedTimeToEl.textContent = `${formatElapsed(-remainingMs)} overdue`;
    feedTimeToEl.classList.add("feeding-metric-value--overdue");
  } else {
    feedTimeToEl.textContent = formatElapsed(remainingMs);
    feedTimeToEl.classList.remove("feeding-metric-value--overdue");
  }
}

function renderFeeds() {
  feedsListEl.innerHTML = "";
  feedsEmptyEl.hidden = feeds.length > 0;

  for (const f of feeds) {
    const li = document.createElement("li");
    li.className = "feed-item";

    const title = document.createElement("div");
    title.className = "feed-item-title";
    const left = document.createElement("div");
    const right = document.createElement("div");
    right.textContent = formatTimeOnly(f.startedAtMs);

    left.textContent = f.side2
      ? `${f.side1} ${formatDurationSec(f.duration1Sec)} + ${f.side2} ${formatDurationSec(f.duration2Sec || 0)}`
      : `${f.side1} ${formatDurationSec(f.duration1Sec)}`;
    title.append(left, right);

    const meta = document.createElement("div");
    meta.className = "feed-item-meta";
    meta.textContent = f.side2 ? "Two sides" : "One side";

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
        // Optimistic UI update (Realtime DELETE payload may not include old row without REPLICA IDENTITY FULL)
        feeds = feeds.filter((x) => x.id !== f.id);
        renderFeeds();
        setSyncMessage("");
      } catch (e) {
        console.error(e);
        setSyncMessage("Could not delete feed.", true);
      }
    });

    const top = document.createElement("div");
    top.className = "feed-item-top";
    top.append(title, del);

    li.append(top, meta);
    feedsListEl.appendChild(li);
  }
  renderFeedingMetrics();
}

function showState(name) {
  feedingStateIdle.hidden = name !== "idle";
  feedingStateRunning.hidden = name !== "running";
  feedingStateAfter.hidden = name !== "after";
  if (feedingRunningWrap) feedingRunningWrap.hidden = name !== "running";
}

function setControlsEnabled(on) {
  feedLeftBtn.disabled = !on;
  feedRightBtn.disabled = !on;
  if (feedPauseBtn) feedPauseBtn.disabled = !on;
  feedStopBtn.disabled = !on;
  feedAddLeftBtn.disabled = !on;
  feedAddRightBtn.disabled = !on;
  feedDoneBtn.disabled = !on;
}

function updateTick() {
  if (!active) return;
  const now = performance.now();
  const runningMs =
    (active.pausedAtPerf == null ? now : active.pausedAtPerf) - active.startedPerf - active.pausedTotalMs;
  const ms = Math.max(0, runningMs);
  feedingElapsed.textContent = formatElapsed(ms);
}

function startPhase(phase, side) {
  active = {
    phase,
    side,
    startedPerf: performance.now(),
    startedWallMs: Date.now(),
    pausedAtPerf: null,
    pausedTotalMs: 0,
    ...(active && active.feedId ? { feedId: active.feedId, side1: active.side1, side1DurationSec: active.side1DurationSec } : {}),
  };
  feedingRunningLabel.textContent =
    phase === "side1" ? `Feeding ${side}…` : `Other side ${side}…`;
  feedingElapsed.textContent = "0:00";
  if (feedPauseBtn) feedPauseBtn.textContent = "Pause";
  showState("running");
  if (tick != null) clearInterval(tick);
  tick = window.setInterval(updateTick, 250);
}

function togglePause() {
  if (!active) return;
  if (active.pausedAtPerf == null) {
    active.pausedAtPerf = performance.now();
    if (feedPauseBtn) feedPauseBtn.textContent = "Resume";
  } else {
    active.pausedTotalMs += Math.max(0, performance.now() - active.pausedAtPerf);
    active.pausedAtPerf = null;
    if (feedPauseBtn) feedPauseBtn.textContent = "Pause";
  }
  updateTick();
}

async function stopPhase() {
  if (!active || !supabase) return;
  if (tick != null) {
    clearInterval(tick);
    tick = null;
  }
  const now = performance.now();
  const runningMs =
    (active.pausedAtPerf == null ? now : active.pausedAtPerf) - active.startedPerf - active.pausedTotalMs;
  const durationSec = Math.max(0, Math.round(Math.max(0, runningMs) / 1000));

  if (active.phase === "side1") {
    setSyncMessage("Saving…");
    setControlsEnabled(false);
    try {
      const row = await insertFeed(supabase, {
        startedAtMs: active.startedWallMs,
        side1: active.side,
        duration1Sec: durationSec,
      });
      active = {
        phase: "side2",
        side: active.side,
        startedPerf: active.startedPerf,
        startedWallMs: active.startedWallMs,
        feedId: row.id,
        side1: row.side1,
        side1DurationSec: row.duration1Sec,
      };
      feedingSummary.textContent = `${row.side1} ${formatDurationSec(row.duration1Sec)}`;
      showState("after");
      setSyncMessage("");
    } catch (e) {
      console.error(e);
      setSyncMessage("Could not save feed.", true);
      showState("idle");
      active = null;
    } finally {
      setControlsEnabled(true);
    }
    return;
  }

  // side2 phase: patch existing row
  if (!active.feedId || !active.side1 || typeof active.side1DurationSec !== "number") {
    showState("idle");
    active = null;
    return;
  }
  setSyncMessage("Saving…");
  setControlsEnabled(false);
  try {
    await addSecondSide(supabase, active.feedId, { side2: active.side, duration2Sec: durationSec });
    feedingSummary.textContent = `${active.side1} ${formatDurationSec(active.side1DurationSec)} + ${active.side} ${formatDurationSec(durationSec)}`;
    showState("after");
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not save second side.", true);
  } finally {
    setControlsEnabled(true);
  }
}

function resetFlow() {
  if (tick != null) {
    clearInterval(tick);
    tick = null;
  }
  active = null;
  feedingSummary.textContent = "";
  showState("idle");
}

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
feedLeftBtn.addEventListener("click", () => startPhase("side1", "L"));
feedRightBtn.addEventListener("click", () => startPhase("side1", "R"));
feedPauseBtn?.addEventListener("click", () => togglePause());
feedStopBtn.addEventListener("click", () => void stopPhase());
feedAddLeftBtn.addEventListener("click", () => startPhase("side2", "L"));
feedAddRightBtn.addEventListener("click", () => startPhase("side2", "R"));
feedDoneBtn.addEventListener("click", () => resetFlow());

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void signInWithPassword();
});
loginDialog?.addEventListener("cancel", (e) => e.preventDefault());
signOutBtn?.addEventListener("click", () => void signOut());

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

