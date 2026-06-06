import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { pullFeedsForDay } from "./feeds.js";
import { installPullToRefresh } from "./pull_to_refresh.js";
import { waitForInitialSession } from "./auth.js";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const syncStatusEl = document.getElementById("syncStatus");
const timelinePrevBtn = document.getElementById("timelinePrev");
const timelineNextBtn = document.getElementById("timelineNext");
const timelineTodayBtn = document.getElementById("timelineToday");
const timelineDateLabel = document.getElementById("timelineDateLabel");
const timelineScroll = document.getElementById("timelineScroll");
const timelineInner = document.getElementById("timelineInner");

const loginDialog = document.getElementById("loginDialog");
const loginForm = document.getElementById("loginForm");
const loginEmailInput = document.getElementById("loginEmail");
const loginPasswordInput = document.getElementById("loginPassword");
const loginErrorEl = document.getElementById("loginError");
const loginSubmitBtn = document.getElementById("loginSubmit");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Pixels per minute of the day. Adjust to taste. */
const PX_PER_MIN = 4;
/** Total timeline height for 24 hours. */
const TIMELINE_HEIGHT_PX = 24 * 60 * PX_PER_MIN;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;

/** Current displayed date (local midnight). @type {Date} */
let currentDate = todayMidnight();

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayStartMs(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayEndMs(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + 24 * 60 * 60 * 1000;
}

function formatDateLabel(date) {
  const today = todayMidnight();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const ds = date.toDateString();
  if (ds === today.toDateString()) return "Today";
  if (ds === yesterday.toDateString()) return "Yesterday";
  if (ds === tomorrow.toDateString()) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function minutesSinceMidnight(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

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
  if (!text) { loginErrorEl.hidden = true; loginErrorEl.textContent = ""; return; }
  loginErrorEl.hidden = false;
  loginErrorEl.textContent = text;
}

function showLogin() {
  setLoginError("");
  if (loginDialog && typeof loginDialog.showModal === "function" && !loginDialog.open) {
    loginDialog.showModal();
    loginEmailInput?.focus();
  }
}

function formatTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDurationSec(sec) {
  let s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const r = s % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (r > 0 || parts.length === 0) parts.push(`${r}s`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * @param {import("./feeds.js").FeedRow[]} feeds
 * @param {Array<never>} _sleeps  — reserved for future sleep data
 */
function renderTimeline(feeds, _sleeps) {
  if (!timelineInner) return;
  timelineInner.innerHTML = "";
  timelineInner.style.height = `${TIMELINE_HEIGHT_PX}px`;

  // Hour labels (left axis).
  const axis = document.createElement("div");
  axis.className = "tl-axis";
  for (let h = 0; h < 24; h++) {
    const tick = document.createElement("div");
    tick.className = "tl-hour-tick";
    tick.style.top = `${h * 60 * PX_PER_MIN}px`;

    const label = document.createElement("span");
    label.className = "tl-hour-label";
    label.textContent = `${String(h).padStart(2, "0")}:00`;
    tick.appendChild(label);
    axis.appendChild(tick);
  }
  timelineInner.appendChild(axis);

  // Event track (right of axis).
  const track = document.createElement("div");
  track.className = "tl-track";

  // Hour grid lines.
  for (let h = 0; h < 24; h++) {
    const line = document.createElement("div");
    line.className = `tl-grid-line${h === 0 ? " tl-grid-line--midnight" : ""}`;
    line.style.top = `${h * 60 * PX_PER_MIN}px`;
    track.appendChild(line);
  }

  // Current-time indicator (only for today).
  if (dayStartMs(currentDate) === dayStartMs(todayMidnight())) {
    const nowLine = document.createElement("div");
    nowLine.className = "tl-now-line";
    const nowMin = minutesSinceMidnight(Date.now());
    nowLine.style.top = `${nowMin * PX_PER_MIN}px`;
    track.appendChild(nowLine);
  }

  // Feed events.
  for (const feed of feeds) {
    const topMin = minutesSinceMidnight(feed.startedAtMs);
    const topPx = topMin * PX_PER_MIN;

    const totalSec = feed.duration1Sec + (feed.duration2Sec ?? 0);
    const durationPx = Math.max(0, Math.round((totalSec / 60) * PX_PER_MIN));

    const el = document.createElement("div");
    el.className = "tl-event tl-event--feed";
    el.style.top = `${topPx}px`;
    if (durationPx > 0) el.style.setProperty("--tl-duration-px", `${durationPx}px`);

    const pill = document.createElement("div");
    pill.className = "tl-event-pill";

    const timeSpan = document.createElement("span");
    timeSpan.className = "tl-event-time";
    timeSpan.textContent = formatTime(feed.startedAtMs);

    const sideSpan = document.createElement("span");
    sideSpan.className = "tl-event-side";
    const sides = [feed.side1, feed.side2].filter(Boolean).join("+");
    sideSpan.textContent = sides;

    pill.append(timeSpan, sideSpan);

    if (totalSec > 0) {
      const durSpan = document.createElement("span");
      durSpan.className = "tl-event-dur";
      durSpan.textContent = formatDurationSec(totalSec);
      pill.appendChild(durSpan);
    }

    el.appendChild(pill);

    if (durationPx > 4) {
      const bar = document.createElement("div");
      bar.className = "tl-event-bar";
      bar.style.height = `${durationPx}px`;
      el.appendChild(bar);
    }

    track.appendChild(el);
  }

  // Placeholder for future sleep blocks — rendered here when sleep data arrives.
  // for (const sleep of _sleeps) { ... }

  timelineInner.appendChild(track);
}

function updateDateLabel() {
  if (timelineDateLabel) timelineDateLabel.textContent = formatDateLabel(currentDate);
  const today = todayMidnight();
  if (timelineNextBtn) timelineNextBtn.disabled = currentDate >= today;
}

function scrollToNowOrFirstEvent(feeds) {
  if (!timelineScroll) return;
  const isToday = dayStartMs(currentDate) === dayStartMs(todayMidnight());
  if (isToday) {
    const nowMin = minutesSinceMidnight(Date.now());
    const targetPx = Math.max(0, nowMin * PX_PER_MIN - timelineScroll.clientHeight / 2);
    timelineScroll.scrollTop = targetPx;
  } else if (feeds.length > 0) {
    const firstMin = minutesSinceMidnight(feeds[0].startedAtMs);
    const targetPx = Math.max(0, firstMin * PX_PER_MIN - 60);
    timelineScroll.scrollTop = targetPx;
  } else {
    timelineScroll.scrollTop = 0;
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadDay(date, scrollToNow) {
  if (!supabase) return;
  setSyncMessage("Loading…");
  try {
    const feeds = await pullFeedsForDay(supabase, dayStartMs(date), dayEndMs(date));
    // Future: const sleeps = await pullSleepsForDay(supabase, dayStartMs(date), dayEndMs(date));
    renderTimeline(feeds, []);
    if (scrollToNow) scrollToNowOrFirstEvent(feeds);
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not load timeline.", true);
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function signInWithPassword() {
  if (!supabase) return;
  const email = loginEmailInput.value.trim();
  const password = loginPasswordInput.value;
  if (!email || !password) { setLoginError("Enter email and password."); return; }
  setLoginError("");
  loginSubmitBtn.disabled = true;
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setLoginError(error.message || "Sign-in failed."); return; }
    loginPasswordInput.value = "";
    if (loginDialog?.open) loginDialog.close();
    await loadDay(currentDate, true);
  } finally {
    loginSubmitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

timelinePrevBtn?.addEventListener("click", () => {
  currentDate.setDate(currentDate.getDate() - 1);
  updateDateLabel();
  void loadDay(currentDate, false);
});

timelineNextBtn?.addEventListener("click", () => {
  const today = todayMidnight();
  if (currentDate >= today) return;
  currentDate.setDate(currentDate.getDate() + 1);
  updateDateLabel();
  void loadDay(currentDate, currentDate.toDateString() === today.toDateString());
});

timelineTodayBtn?.addEventListener("click", () => {
  currentDate = todayMidnight();
  updateDateLabel();
  void loadDay(currentDate, true);
});

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void signInWithPassword();
});
loginDialog?.addEventListener("cancel", (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  installPullToRefresh();
  updateDateLabel();

  if (!useCloud()) {
    setSyncMessage("Cloud is not configured (supabase-config.js).", true);
    renderTimeline([], []);
    return;
  }

  supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      renderTimeline([], []);
      setSyncMessage("Sign in to view your timeline.");
      showLogin();
    }
  });

  const session = await waitForInitialSession(supabase);
  if (session?.user) {
    await loadDay(currentDate, true);
  } else {
    setSyncMessage("Sign in to view your timeline.");
    renderTimeline([], []);
    showLogin();
  }
}

void bootstrap();
