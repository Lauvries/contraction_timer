import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  pullSleeps,
  insertSleep,
  updateSleep,
  deleteSleep,
  deleteAllSleepsForUser,
  subscribeSleepsRealtime,
} from "./sleeps.js";
import { installPullToRefresh } from "./pull_to_refresh.js";
import { waitForInitialSession } from "./auth.js";
import { applyTabVisibility } from "./nav.js";

const syncStatusEl = document.getElementById("syncStatus");
const sleepNowValue = document.getElementById("sleepNowValue");
const sleepNowHint = document.getElementById("sleepNowHint");
const sleepTodayValue = document.getElementById("sleepTodayValue");
const sleepElapsedWrap = document.getElementById("sleepElapsed");
const sleepElapsedValue = document.getElementById("sleepElapsedValue");
const mainBtn = document.getElementById("sleepMainBtn");
const mainBtnLabel = document.getElementById("sleepMainBtnLabel");
const logPastBtn = document.getElementById("sleepLogPastBtn");
const sleepList = document.getElementById("sleepList");
const sleepEmpty = document.getElementById("sleepEmpty");
const clearAllBtn = document.getElementById("sleepClearAllBtn");
const prevPageBtn = document.getElementById("sleepPrevPage");
const nextPageBtn = document.getElementById("sleepNextPage");
const pageLabel = document.getElementById("sleepPageLabel");
const signOutBtn = document.getElementById("signOutBtn");
const loginDialog = document.getElementById("loginDialog");
const loginForm = document.getElementById("loginForm");
const loginEmailInput = document.getElementById("loginEmail");
const loginPasswordInput = document.getElementById("loginPassword");
const loginErrorEl = document.getElementById("loginError");
const loginSubmitBtn = document.getElementById("loginSubmit");

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {import("./sleeps.js").SleepRow[]} */
let sleeps = [];
/** @type {(() => void) | null} */
let unsubscribeRealtime = null;
let appReady = false;

/** @type {string | null} */
let editingStartId = null;
/** @type {string | null} */
let editingEndId = null;

/** @type {number | null} */
let tickId = null;

const PAGE_SIZE = 20;
let page = 0;

// ---------------------------------------------------------------------------
// Helpers
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
  if (!text) {
    loginErrorEl.hidden = true;
    loginErrorEl.textContent = "";
    return;
  }
  loginErrorEl.hidden = false;
  loginErrorEl.textContent = text;
}

function showLoginModal() {
  setLoginError("");
  if (loginDialog && typeof loginDialog.showModal === "function" && !loginDialog.open) {
    loginDialog.showModal();
    loginEmailInput?.focus();
  }
}

function updateSignOutVisibility(signedIn) {
  if (!signOutBtn) return;
  signOutBtn.hidden = !useCloud() || !signedIn;
}

/** @returns {import("./sleeps.js").SleepRow | null} */
function findActiveSleep() {
  return sleeps.find((s) => s.endedAtMs == null) || null;
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const ds = new Date(d);
  ds.setHours(0, 0, 0, 0);
  if (ds.getTime() === today.getTime()) return "Today";
  if (ds.getTime() === yesterday.getTime()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d);
}

function toTimeInputValue(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function applyTimeStringToMs(prevMs, timeStr) {
  const d = new Date(prevMs);
  const parts = timeStr.split(":").map((p) => Number(p));
  const hh = parts[0];
  const mm = parts[1] ?? 0;
  const ss = parts[2] ?? 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return prevMs;
  d.setHours(hh, mm, Number.isFinite(ss) ? ss : 0, 0);
  return d.getTime();
}

function formatDuration(ms) {
  let sec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(sec / 3600);
  sec %= 3600;
  const m = Math.floor(sec / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

function newEntryId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* ignore */
    }
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

// ---------------------------------------------------------------------------
// Cloud sync
// ---------------------------------------------------------------------------

function teardownRealtime() {
  if (unsubscribeRealtime) {
    unsubscribeRealtime();
    unsubscribeRealtime = null;
  }
}

function setSleepsList(next) {
  sleeps = next;
  if (appReady) {
    renderHistory();
    renderStats();
    syncMainButton();
  }
}

async function loadCloudDataAfterAuth() {
  if (!supabase) return;
  sleeps = await pullSleeps(supabase);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.id) {
    teardownRealtime();
    unsubscribeRealtime = subscribeSleepsRealtime(supabase, user.id, setSleepsList, () => sleeps, setSyncMessage);
  }
  setSyncMessage("");
  updateSignOutVisibility(true);
  if (loginDialog && loginDialog.open) loginDialog.close();
  renderHistory();
  renderStats();
  syncMainButton();
}

async function submitLogin() {
  if (!supabase || !loginEmailInput || !loginPasswordInput) return;
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
    await loadCloudDataAfterAuth();
  } finally {
    loginSubmitBtn.disabled = false;
  }
}

async function signOutCloud() {
  if (!supabase) return;
  teardownRealtime();
  await supabase.auth.signOut();
  sleeps = [];
  updateSignOutVisibility(false);
  renderHistory();
  renderStats();
  syncMainButton();
  setSyncMessage("Sign in to sync your list.");
  showLoginModal();
}

// ---------------------------------------------------------------------------
// Live "asleep" timer
// ---------------------------------------------------------------------------

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function stopTick() {
  if (tickId !== null) {
    clearInterval(tickId);
    tickId = null;
  }
}

function updateTick() {
  const active = findActiveSleep();
  if (!active) {
    stopTick();
    return;
  }
  const elapsed = Date.now() - active.startedAtMs;
  sleepElapsedValue.textContent = formatElapsed(elapsed);
  sleepNowValue.textContent = `Asleep ${formatDuration(elapsed)}`;
  sleepNowHint.textContent = `Since ${formatClock(active.startedAtMs)}`;
}

function startTick() {
  stopTick();
  updateTick();
  tickId = window.setInterval(updateTick, 1000);
}

function syncMainButton() {
  const active = findActiveSleep();
  if (active) {
    mainBtn.classList.add("is-active");
    mainBtn.setAttribute("aria-pressed", "true");
    mainBtnLabel.textContent = "Wake up";
    sleepElapsedWrap.hidden = false;
    startTick();
  } else {
    mainBtn.classList.remove("is-active");
    mainBtn.setAttribute("aria-pressed", "false");
    mainBtnLabel.textContent = "Start sleep";
    sleepElapsedWrap.hidden = true;
    stopTick();
  }
}

// ---------------------------------------------------------------------------
// CRUD actions
// ---------------------------------------------------------------------------

async function startSleep() {
  if (!supabase || !appReady) return;
  if (findActiveSleep()) return;
  const entry = { id: newEntryId(), startedAtMs: Date.now(), endedAtMs: null, quickLog: false };
  sleeps = [entry, ...sleeps];
  renderHistory();
  renderStats();
  syncMainButton();
  setSyncMessage("Saving…");
  try {
    const saved = await insertSleep(supabase, { startedAtMs: entry.startedAtMs, endedAtMs: null, quickLog: false });
    const i = sleeps.findIndex((s) => s.id === entry.id);
    if (i !== -1) sleeps[i] = saved;
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not start tracking — try again.", true);
    sleeps = sleeps.filter((s) => s.id !== entry.id);
    renderHistory();
    renderStats();
    syncMainButton();
  }
}

async function endSleep() {
  if (!supabase || !appReady) return;
  const active = findActiveSleep();
  if (!active) return;
  const endedAtMs = Date.now();
  const idx = sleeps.findIndex((s) => s.id === active.id);
  if (idx !== -1) sleeps[idx] = { ...sleeps[idx], endedAtMs };
  renderHistory();
  renderStats();
  syncMainButton();
  setSyncMessage("Saving…");
  try {
    await updateSleep(supabase, active.id, { endedAtMs });
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not save wake-up time.", true);
    const j = sleeps.findIndex((s) => s.id === active.id);
    if (j !== -1) sleeps[j] = { ...sleeps[j], endedAtMs: null };
    renderHistory();
    renderStats();
    syncMainButton();
  }
}

async function logPastSleep() {
  if (!supabase || !appReady) return;
  const endedAtMs = Date.now();
  const startedAtMs = endedAtMs - 30 * 60 * 1000;
  setSyncMessage("Saving…");
  try {
    const saved = await insertSleep(supabase, { startedAtMs, endedAtMs, quickLog: true });
    sleeps = [saved, ...sleeps].sort((a, b) => b.startedAtMs - a.startedAtMs);
    page = 0;
    editingStartId = saved.id;
    editingEndId = null;
    renderHistory();
    renderStats();
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not log sleep — try again.", true);
  }
}

async function patchSleep(id, patch) {
  const idx = sleeps.findIndex((s) => s.id === id);
  if (idx === -1 || !supabase) return;
  const prev = sleeps[idx];
  const next = { ...prev, ...patch };
  sleeps[idx] = next;
  sleeps.sort((a, b) => b.startedAtMs - a.startedAtMs);
  renderHistory();
  renderStats();
  syncMainButton();
  setSyncMessage("Saving…");
  try {
    await updateSleep(supabase, id, patch);
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not save — check connection.", true);
    const j = sleeps.findIndex((s) => s.id === id);
    if (j !== -1) sleeps[j] = prev;
    sleeps.sort((a, b) => b.startedAtMs - a.startedAtMs);
    renderHistory();
    renderStats();
    syncMainButton();
  }
}

async function removeSleep(id) {
  if (!confirm("Remove this sleep session?")) return;
  if (editingStartId === id) editingStartId = null;
  if (editingEndId === id) editingEndId = null;
  if (!supabase) return;
  const prev = sleeps;
  sleeps = sleeps.filter((s) => s.id !== id);
  renderHistory();
  renderStats();
  syncMainButton();
  try {
    await deleteSleep(supabase, id);
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not delete — try again.", true);
    sleeps = prev;
    renderHistory();
    renderStats();
    syncMainButton();
  }
}

async function clearAllSleeps() {
  if (!confirm("Remove all logged sleep sessions? This cannot be undone.")) return;
  if (!supabase) return;
  editingStartId = null;
  editingEndId = null;
  const prev = sleeps;
  sleeps = [];
  renderHistory();
  renderStats();
  syncMainButton();
  try {
    await deleteAllSleepsForUser(supabase);
    setSyncMessage("");
  } catch (e) {
    console.error(e);
    setSyncMessage("Could not clear list.", true);
    sleeps = prev;
    renderHistory();
    renderStats();
    syncMainButton();
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function renderStats() {
  const active = findActiveSleep();
  if (active) {
    const elapsed = Date.now() - active.startedAtMs;
    sleepNowValue.textContent = `Asleep ${formatDuration(elapsed)}`;
    sleepNowHint.textContent = `Since ${formatClock(active.startedAtMs)}`;
  } else {
    sleepNowValue.textContent = "Awake";
    const last = sleeps.find((s) => s.endedAtMs != null);
    sleepNowHint.textContent = last ? `Last woke at ${formatClock(/** @type {number} */ (last.endedAtMs))}` : "";
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startMs = todayStart.getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  const now = Date.now();

  let totalMs = 0;
  for (const s of sleeps) {
    const segStart = Math.max(s.startedAtMs, startMs);
    const segEnd = Math.min(s.endedAtMs ?? now, endMs);
    if (segEnd > segStart) totalMs += segEnd - segStart;
  }
  sleepTodayValue.textContent = totalMs > 0 ? formatDuration(totalMs) : "—";
}

// ---------------------------------------------------------------------------
// History list
// ---------------------------------------------------------------------------

function makeTimeEditCell(sleep, field) {
  const isStart = field === "start";
  const ms = isStart ? sleep.startedAtMs : sleep.endedAtMs;
  const editingId = isStart ? editingStartId : editingEndId;
  const otherEditingId = isStart ? editingEndId : editingStartId;

  const wrap = document.createElement("span");
  wrap.className = "sleep-manual-edit-row";

  if (ms == null) {
    // Ongoing session — no end time yet.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-pill-btn history-pill-btn--primary";
    btn.textContent = "End now";
    btn.addEventListener("click", () => void endSleep());
    wrap.appendChild(btn);
    return wrap;
  }

  if (editingId === sleep.id) {
    const input = document.createElement("input");
    input.type = "time";
    input.step = "1";
    input.className = "history-time-input";
    input.value = toTimeInputValue(ms);

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "history-pill-btn history-pill-btn--primary";
    apply.textContent = "OK";
    apply.addEventListener("click", () => {
      const newMs = applyTimeStringToMs(ms, input.value);
      const wouldBeAfterEnd = isStart && sleep.endedAtMs != null && newMs > sleep.endedAtMs;
      const wouldBeBeforeStart = !isStart && newMs < sleep.startedAtMs;
      if (wouldBeAfterEnd || wouldBeBeforeStart) {
        setSyncMessage(isStart ? "Start time must be before the wake time." : "Wake time must be after the start time.", true);
        return;
      }
      if (isStart) editingStartId = null;
      else editingEndId = null;
      void patchSleep(sleep.id, isStart ? { startedAtMs: newMs } : { endedAtMs: newMs });
    });

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "history-pill-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      if (isStart) editingStartId = null;
      else editingEndId = null;
      renderHistory();
    });

    wrap.append(input, apply, cancel);
    return wrap;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-meta-btn history-meta-btn--time";
  btn.textContent = formatClock(ms);
  btn.title = isStart ? "Edit start time" : "Edit wake time";
  btn.addEventListener("click", () => {
    if (isStart) {
      editingStartId = sleep.id;
      if (otherEditingId === sleep.id) editingEndId = null;
    } else {
      editingEndId = sleep.id;
      if (otherEditingId === sleep.id) editingStartId = null;
    }
    renderHistory();
  });
  wrap.appendChild(btn);
  return wrap;
}

function renderHistory() {
  if (!sleepList) return;
  sleepList.innerHTML = "";
  sleepEmpty.hidden = sleeps.length > 0;
  clearAllBtn.hidden = sleeps.length === 0;

  const total = sleeps.length;
  const totalPages = total <= 0 ? 0 : Math.ceil(total / PAGE_SIZE);
  page = totalPages <= 0 ? 0 : Math.max(0, Math.min(page, totalPages - 1));

  if (pageLabel) pageLabel.textContent = totalPages <= 1 ? "" : `Page ${page + 1} / ${totalPages}`;
  const paginationEl = prevPageBtn?.closest(".feed-pagination");
  if (paginationEl) paginationEl.hidden = totalPages <= 1;
  if (prevPageBtn) prevPageBtn.disabled = totalPages <= 1 || page <= 0;
  if (nextPageBtn) nextPageBtn.disabled = totalPages <= 1 || page >= totalPages - 1;

  const start = page * PAGE_SIZE;
  const pageItems = sleeps.slice(start, start + PAGE_SIZE);

  for (const s of pageItems) {
    const li = document.createElement("li");
    li.className = "history-item";

    const rowTop = document.createElement("div");
    rowTop.className = "history-item-row";
    const dayLabel = document.createElement("span");
    dayLabel.className = "history-since-prior-label";
    dayLabel.textContent = formatDayLabel(s.startedAtMs);
    rowTop.appendChild(dayLabel);
    if (s.endedAtMs == null) {
      const badge = document.createElement("span");
      badge.className = "sleep-ongoing-badge";
      badge.textContent = "Asleep now";
      rowTop.appendChild(badge);
    }
    li.appendChild(rowTop);

    const rowMeta = document.createElement("div");
    rowMeta.className = "history-item-row history-item-row--meta sleep-manual-edit";

    const startLab = document.createElement("span");
    startLab.className = "sleep-manual-edit-label";
    startLab.textContent = "Asleep";
    rowMeta.appendChild(startLab);
    rowMeta.appendChild(makeTimeEditCell(s, "start"));

    const arrow = document.createElement("span");
    arrow.className = "history-meta-sep";
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    rowMeta.appendChild(arrow);

    const endLab = document.createElement("span");
    endLab.className = "sleep-manual-edit-label";
    endLab.textContent = "Woke";
    rowMeta.appendChild(endLab);
    rowMeta.appendChild(makeTimeEditCell(s, "end"));

    const spacer = document.createElement("span");
    spacer.className = "history-meta-spacer";
    rowMeta.appendChild(spacer);

    if (s.endedAtMs != null) {
      const dur = document.createElement("span");
      dur.className = "history-meta-btn history-meta-btn--dur";
      dur.style.cursor = "default";
      dur.textContent = formatDuration(s.endedAtMs - s.startedAtMs);
      rowMeta.appendChild(dur);
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-icon-btn history-delete-btn";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove sleep session");
    del.addEventListener("click", () => void removeSleep(s.id));
    rowMeta.appendChild(del);

    li.appendChild(rowMeta);
    sleepList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

mainBtn.addEventListener("click", () => {
  if (findActiveSleep()) void endSleep();
  else void startSleep();
});

logPastBtn?.addEventListener("click", () => void logPastSleep());
clearAllBtn.addEventListener("click", () => void clearAllSleeps());

prevPageBtn?.addEventListener("click", () => {
  page = Math.max(0, page - 1);
  renderHistory();
});
nextPageBtn?.addEventListener("click", () => {
  const totalPages = sleeps.length <= 0 ? 0 : Math.ceil(sleeps.length / PAGE_SIZE);
  page = Math.min(Math.max(0, totalPages - 1), page + 1);
  renderHistory();
});

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void submitLogin();
});
loginDialog?.addEventListener("cancel", (e) => e.preventDefault());
signOutBtn?.addEventListener("click", () => void signOutCloud());

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  applyTabVisibility();
  document.body.classList.add("app-loading");
  setSyncMessage("");
  installPullToRefresh();
  try {
    if (useCloud()) {
      setSyncMessage("Loading your data…");
      supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });

      supabase.auth.onAuthStateChange((event) => {
        if (!useCloud()) return;
        if (event === "SIGNED_OUT") {
          teardownRealtime();
          sleeps = [];
          updateSignOutVisibility(false);
          if (appReady) {
            renderHistory();
            renderStats();
            syncMainButton();
          }
          setSyncMessage("Sign in to sync your list.");
          if (loginDialog && typeof loginDialog.showModal === "function" && !loginDialog.open) {
            showLoginModal();
          }
        }
      });

      const session = await waitForInitialSession(supabase);
      if (session) {
        sleeps = await pullSleeps(supabase);
        setSyncMessage("");
        updateSignOutVisibility(true);
        if (session.user?.id) {
          unsubscribeRealtime = subscribeSleepsRealtime(
            supabase,
            session.user.id,
            setSleepsList,
            () => sleeps,
            setSyncMessage
          );
        }
      } else {
        setSyncMessage("Sign in to sync your list.");
        updateSignOutVisibility(false);
        showLoginModal();
      }
    } else {
      setSyncMessage("Cloud is not configured (supabase-config.js).", true);
    }
  } catch (e) {
    console.error(e);
    setSyncMessage("Cloud sync failed — check supabase-config.js and schema.", true);
    sleeps = [];
  } finally {
    appReady = true;
    document.body.classList.remove("app-loading");
  }

  renderHistory();
  renderStats();
  syncMainButton();
}

void bootstrap();
