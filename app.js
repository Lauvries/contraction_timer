import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const STORAGE_KEY = "contraction-timer-v1";
const LAST_INTENSITY_KEY = "lastIntensity";
const TARGET_DURATION_SEC_KEY = "targetDurationSec";
const LIVE_TIMER_KEY = "liveTimerEnabled";

const mainBtn = document.getElementById("mainBtn");
const mainBtnLabel = document.getElementById("mainBtnLabel");
const elapsedWrap = document.getElementById("elapsed");
const elapsedValue = document.getElementById("elapsedValue");
const targetLine = document.getElementById("targetLine");
const historyList = document.getElementById("historyList");
const historyEmpty = document.getElementById("historyEmpty");
const clearAllBtn = document.getElementById("clearAllBtn");
const contractionsPrevPageBtn = document.getElementById("contractionsPrevPage");
const contractionsNextPageBtn = document.getElementById("contractionsNextPage");
const contractionsPageLabel = document.getElementById("contractionsPageLabel");
const avgIntervalEl = document.getElementById("avgInterval");
const avgIntervalHint = document.getElementById("avgIntervalHint");
const openOptionsBtn = document.getElementById("openOptions");
const optionsDialog = document.getElementById("optionsDialog");
const optionsForm = document.getElementById("optionsForm");
const targetMinutesInput = document.getElementById("targetMinutes");
const targetSecondsInput = document.getElementById("targetSeconds");
const clearTargetBtn = document.getElementById("clearTarget");
const liveTimerToggle = document.getElementById("liveTimerToggle");
const timerModeHint = document.getElementById("timerModeHint");
const syncStatusEl = document.getElementById("syncStatus");
const loginDialog = document.getElementById("loginDialog");
const loginForm = document.getElementById("loginForm");
const loginEmailInput = document.getElementById("loginEmail");
const loginPasswordInput = document.getElementById("loginPassword");
const loginErrorEl = document.getElementById("loginError");
const loginSubmitBtn = document.getElementById("loginSubmit");
const signOutBtn = document.getElementById("signOutBtn");
const reloadBtn = document.getElementById("reloadBtn");

/** @type {string | null} */
let editingTimeId = null;
/** @type {string | null} */
let editingDurationId = null;

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabase = null;
/** @type {Array<{ id: string, endMs: number, intensity: number, durationSec: number | null }>} */
let cloudContractions = [];
/** @type {import("@supabase/supabase-js").RealtimeChannel | null} */
let contractionsRealtimeChannel = null;
let appReady = false;

const CONTRACTIONS_PAGE_SIZE = 20;
let contractionsPage = 0;

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

function newEntryId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* ignore */
    }
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/** @type {{ start: number } | null} */
let activeSession = null;
/** @type {number | null} */
let tickId = null;

function loadLastIntensity() {
  const n = Number(localStorage.getItem(LAST_INTENSITY_KEY));
  if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
  return 5;
}

function saveLastIntensity(n) {
  localStorage.setItem(LAST_INTENSITY_KEY, String(n));
}

function getIntensityForNextEntry() {
  const list = loadContractions();
  if (list.length > 0) return list[0].intensity;
  return loadLastIntensity();
}

/** @param {{ endMs: number, durationSec: number | null }} c */
function contractionStartMs(c) {
  if (c.durationSec == null) return null;
  return c.endMs - c.durationSec * 1000;
}

function gapBetweenContractionsMs(older, newer) {
  const tOld = contractionStartMs(older);
  const tNew = contractionStartMs(newer);
  if (tOld != null && tNew != null) return tNew - tOld;
  return newer.endMs - older.endMs;
}

function describeGapSincePrior(older, newer) {
  const ms = gapBetweenContractionsMs(older, newer);
  const both = older.durationSec != null && newer.durationSec != null;
  if (!Number.isFinite(ms) || ms < 0) {
    return { text: "—", title: "Could not compute interval (check times and durations)." };
  }
  return {
    text: formatInterval(ms),
    title: both
      ? "Start of this contraction minus start of the one below (standard frequency)."
      : "Time between ends — add duration on both rows for start-to-start.",
  };
}

function loadLiveTimer() {
  return localStorage.getItem(LIVE_TIMER_KEY) === "1";
}

function saveLiveTimer(on) {
  localStorage.setItem(LIVE_TIMER_KEY, on ? "1" : "0");
}

/** @returns {number | null} */
function loadTargetDurationSec() {
  const raw = localStorage.getItem(TARGET_DURATION_SEC_KEY);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), 59 * 60 + 59);
}

/** @param {number | null} sec */
function saveTargetDurationSec(sec) {
  if (sec === null || sec <= 0) localStorage.removeItem(TARGET_DURATION_SEC_KEY);
  else localStorage.setItem(TARGET_DURATION_SEC_KEY, String(sec));
}

function openOptionsForm() {
  liveTimerToggle.checked = loadLiveTimer();
  syncTimerModeHint();
  const sec = loadTargetDurationSec();
  if (sec === null) {
    targetMinutesInput.value = "";
    targetSecondsInput.value = "";
  } else {
    targetMinutesInput.value = String(Math.floor(sec / 60));
    targetSecondsInput.value = String(sec % 60);
  }
  if (typeof optionsDialog.showModal === "function") optionsDialog.showModal();
}

function parseDurationFromMinSecInputs(minEl, secEl) {
  const mRaw = minEl.value.trim();
  const sRaw = secEl.value.trim();
  if (mRaw === "" && sRaw === "") return null;
  const m = mRaw === "" ? 0 : Number(mRaw);
  const s = sRaw === "" ? 0 : Number(sRaw);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
  if (!Number.isInteger(m) || !Number.isInteger(s)) return null;
  if (m < 0 || m > 59 || s < 0 || s > 59) return null;
  const total = m * 60 + s;
  return total > 0 ? total : null;
}

function parseOptionsDurationFromInputs() {
  return parseDurationFromMinSecInputs(targetMinutesInput, targetSecondsInput);
}

function saveOptionsFromForm() {
  saveTargetDurationSec(parseOptionsDurationFromInputs());
}

/**
 * @param {Record<string, unknown>} c
 * @returns {{ id: string, endMs: number, intensity: number, durationSec: number | null }}
 */
function normalizeEntry(c) {
  const id = typeof c.id === "string" ? c.id : newEntryId();
  const endMs = typeof c.endMs === "number" ? c.endMs : Date.now();
  let intensity = Number(c.intensity);
  if (!Number.isInteger(intensity) || intensity < 1 || intensity > 10) intensity = 5;

  if (typeof c.durationSec === "number" && Number.isFinite(c.durationSec)) {
    return { id, endMs, intensity, durationSec: Math.max(0, Math.floor(c.durationSec)) };
  }
  if (c.durationSec === null) {
    return { id, endMs, intensity, durationSec: null };
  }
  if (typeof c.startMs === "number" && typeof c.endMs === "number" && c.endMs >= c.startMs) {
    const sec = Math.round((c.endMs - c.startMs) / 1000);
    return { id, endMs, intensity, durationSec: Math.max(0, sec) };
  }
  return { id, endMs, intensity, durationSec: null };
}

function persistEntry(c) {
  return {
    id: c.id,
    endMs: c.endMs,
    intensity: c.intensity,
    durationSec: c.durationSec,
  };
}

function loadContractionsFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (c) => c && typeof c.id === "string" && typeof c.endMs === "number" && typeof c.intensity === "number"
      )
      .map(normalizeEntry)
      .sort((a, b) => b.endMs - a.endMs);
  } catch {
    return [];
  }
}

function saveContractionsToLocalStorage(list) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(list.map(persistEntry).slice(0, 100))
  );
}

/** @returns {Array<{ id: string, endMs: number, intensity: number, durationSec: number | null }>} */
function loadContractions() {
  if (useCloud()) return cloudContractions.slice();
  return loadContractionsFromLocalStorage();
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
  if (loginDialog && typeof loginDialog.showModal === "function") {
    loginDialog.showModal();
    loginEmailInput?.focus();
  }
}

function updateSignOutVisibility(signedIn) {
  if (!signOutBtn) return;
  signOutBtn.hidden = !useCloud() || !signedIn;
}

async function loadCloudDataAfterAuth() {
  if (!supabase) return;
  await pullCloudContractions();
  await migrateLocalToCloudIfNeeded();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.id) subscribeContractionsRealtime(user.id);
  setSyncMessage("");
  updateSignOutVisibility(true);
  if (loginDialog && loginDialog.open) loginDialog.close();
  renderHistory();
  renderStats();
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

async function pullCloudContractions() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("contractions")
    .select("id, end_ms, intensity, duration_sec")
    .order("end_ms", { ascending: false })
    .limit(100);
  if (error) throw error;
  cloudContractions = (data || []).map((r) =>
    normalizeEntry({
      id: r.id,
      endMs: Number(r.end_ms),
      intensity: Number(r.intensity),
      durationSec:
        r.duration_sec === null || r.duration_sec === undefined ? null : Number(r.duration_sec),
    })
  );
}

function teardownContractionsRealtime() {
  if (!supabase || !contractionsRealtimeChannel) {
    contractionsRealtimeChannel = null;
    return;
  }
  void supabase.removeChannel(contractionsRealtimeChannel);
  contractionsRealtimeChannel = null;
}

/** @param {Record<string, unknown>} row */
function rowPayloadToEntry(row) {
  if (!row || typeof row.id !== "string") return null;
  return normalizeEntry({
    id: row.id,
    endMs: Number(row.end_ms),
    intensity: Number(row.intensity),
    durationSec:
      row.duration_sec === null || row.duration_sec === undefined ? null : Number(row.duration_sec),
  });
}

/** @param {import("@supabase/supabase-js").RealtimePostgresChangesPayload<Record<string, unknown>>} payload */
function applyContractionsRealtimePayload(payload) {
  const ev = payload.eventType;
  if (ev === "INSERT") {
    const e = rowPayloadToEntry(/** @type {Record<string, unknown>} */ (payload.new));
    if (!e) return;
    const i = cloudContractions.findIndex((x) => x.id === e.id);
    if (i === -1) cloudContractions.unshift(e);
    else cloudContractions[i] = e;
  } else if (ev === "UPDATE") {
    const e = rowPayloadToEntry(/** @type {Record<string, unknown>} */ (payload.new));
    if (!e) return;
    const i = cloudContractions.findIndex((x) => x.id === e.id);
    if (i !== -1) cloudContractions[i] = e;
    else cloudContractions.unshift(e);
  } else if (ev === "DELETE") {
    const oldRow = /** @type {Record<string, unknown> | undefined} */ (payload.old);
    const id = oldRow && typeof oldRow.id === "string" ? oldRow.id : null;
    if (id) cloudContractions = cloudContractions.filter((x) => x.id !== id);
  }
  cloudContractions.sort((a, b) => b.endMs - a.endMs);
  cloudContractions = cloudContractions.slice(0, 100);
  if (appReady) {
    renderHistory();
    renderStats();
  }
}

/** @param {string} userId */
function subscribeContractionsRealtime(userId) {
  if (!supabase || !userId) return;
  teardownContractionsRealtime();
  contractionsRealtimeChannel = supabase
    .channel(`contractions:${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "contractions",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        try {
          applyContractionsRealtimePayload(payload);
        } catch (e) {
          console.error(e);
        }
      }
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("Realtime:", status, err);
        setSyncMessage("Live sync lost connection — refresh if the list looks wrong.", true);
      }
    });
}

async function cloudInsert(entry) {
  if (!supabase) throw new Error("No client");
  const {
    data: { user },
    error: uerr,
  } = await supabase.auth.getUser();
  if (uerr || !user) throw uerr || new Error("Not signed in");
  const { error } = await supabase.from("contractions").insert({
    id: entry.id,
    user_id: user.id,
    end_ms: entry.endMs,
    intensity: entry.intensity,
    duration_sec: entry.durationSec,
  });
  if (error) throw error;
}

async function cloudUpdateRow(id, patch) {
  if (!supabase) throw new Error("No client");
  const row = /** @type {Record<string, unknown>} */ ({});
  if ("endMs" in patch) row.end_ms = patch.endMs;
  if ("intensity" in patch) row.intensity = patch.intensity;
  if ("durationSec" in patch) row.duration_sec = patch.durationSec;
  const { error } = await supabase.from("contractions").update(row).eq("id", id);
  if (error) throw error;
}

async function cloudDeleteRow(id) {
  if (!supabase) throw new Error("No client");
  const { error } = await supabase.from("contractions").delete().eq("id", id);
  if (error) throw error;
}

async function cloudDeleteAllForUser() {
  if (!supabase) throw new Error("No client");
  const {
    data: { user },
    error: uerr,
  } = await supabase.auth.getUser();
  if (uerr || !user) throw uerr || new Error("Not signed in");
  const { error } = await supabase.from("contractions").delete().eq("user_id", user.id);
  if (error) throw error;
}

async function migrateLocalToCloudIfNeeded() {
  if (!supabase || cloudContractions.length > 0) return;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(data) || data.length === 0) return;
  const {
    data: { user },
    error: uerr,
  } = await supabase.auth.getUser();
  if (uerr || !user) return;
  const rows = data
    .map((c) => normalizeEntry(c))
    .slice(0, 100)
    .map((e) => ({
      id: e.id,
      user_id: user.id,
      end_ms: e.endMs,
      intensity: e.intensity,
      duration_sec: e.durationSec,
    }));
  const { error } = await supabase.from("contractions").insert(rows);
  if (error) {
    console.warn("Cloud migration failed", error);
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  await pullCloudContractions();
}

function abortLiveSession() {
  if (!activeSession) return;
  if (tickId !== null) {
    clearInterval(tickId);
    tickId = null;
  }
  activeSession = null;
  mainBtn.classList.remove("is-active");
  mainBtn.setAttribute("aria-pressed", "false");
  elapsedWrap.hidden = true;
  targetLine.hidden = true;
  targetLine.classList.remove("is-over");
}

function syncMainButtonLabel() {
  if (loadLiveTimer()) {
    mainBtnLabel.textContent = activeSession ? "Stop tracking" : "Start tracking";
  } else {
    mainBtnLabel.textContent = "Log contraction";
  }
}

function syncTimerModeHint() {
  if (loadLiveTimer()) {
    timerModeHint.textContent =
      "Main button runs Start / Stop tracking and records duration automatically.";
  } else {
    timerModeHint.textContent = "Main button adds a list row at the current time; edit details in Recent.";
  }
}

async function updateContraction(id, patch) {
  const list = loadContractions();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const next = { ...list[idx], ...patch };
  if (useCloud()) {
    try {
      await cloudUpdateRow(id, patch);
    } catch (e) {
      console.error(e);
      setSyncMessage("Could not save — check connection and Supabase setup.", true);
      return;
    }
    const j = cloudContractions.findIndex((x) => x.id === id);
    if (j !== -1) cloudContractions[j] = next;
    cloudContractions.sort((a, b) => b.endMs - a.endMs);
    cloudContractions = cloudContractions.slice(0, 100);
    setSyncMessage("");
  } else {
    list[idx] = next;
    saveContractionsToLocalStorage(list);
  }
  renderHistory();
  renderStats();
}

async function removeContraction(id) {
  if (!confirm("Remove this contraction?")) return;
  if (editingTimeId === id) editingTimeId = null;
  if (editingDurationId === id) editingDurationId = null;
  if (useCloud()) {
    try {
      await cloudDeleteRow(id);
    } catch (e) {
      console.error(e);
      setSyncMessage("Could not delete — try again.", true);
      return;
    }
    cloudContractions = cloudContractions.filter((x) => x.id !== id);
    setSyncMessage("");
  } else {
    const list = loadContractionsFromLocalStorage().filter((x) => x.id !== id);
    saveContractionsToLocalStorage(list);
  }
  renderHistory();
  renderStats();
}

async function clearAllContractions() {
  if (!confirm("Remove all logged contractions? This cannot be undone.")) return;
  editingTimeId = null;
  editingDurationId = null;
  if (useCloud()) {
    try {
      await cloudDeleteAllForUser();
    } catch (e) {
      console.error(e);
      setSyncMessage("Could not clear list.", true);
      return;
    }
    cloudContractions = [];
    setSyncMessage("");
  } else {
    saveContractionsToLocalStorage([]);
  }
  renderHistory();
  renderStats();
}

function computeAverageIntervalLastFive(items) {
  if (items.length < 2) return null;
  const newestFirst = items.slice(0, 5);
  const chronological = [...newestFirst].sort((a, b) => a.endMs - b.endMs);
  /** @type {number[]} */
  const gapMsList = [];
  for (let i = 1; i < chronological.length; i++) {
    const ms = gapBetweenContractionsMs(chronological[i - 1], chronological[i]);
    if (!Number.isFinite(ms) || ms < 0) continue;
    gapMsList.push(ms);
  }
  if (gapMsList.length === 0) return null;
  const avgMs = gapMsList.reduce((a, b) => a + b, 0) / gapMsList.length;
  return { avgMs, gapCount: gapMsList.length, entryCount: newestFirst.length };
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTimeOnly(tsMs) {
  const d = new Date(tsMs);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function toTimeInputValue(tsMs) {
  const d = new Date(tsMs);
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function applyTimeStringToEndMs(prevEndMs, timeStr) {
  const d = new Date(prevEndMs);
  const parts = timeStr.split(":").map((p) => Number(p));
  const hh = parts[0];
  const mm = parts[1] ?? 0;
  const ss = parts[2] ?? 0;
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return prevEndMs;
  d.setHours(hh, mm, Number.isFinite(ss) ? ss : 0, 0);
  return d.getTime();
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function formatInterval(ms) {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function parseInlineDurationValue(mIn, sIn) {
  const mRaw = mIn.value.trim();
  const sRaw = sIn.value.trim();
  if (mRaw === "" && sRaw === "") return null;
  const m = mRaw === "" ? 0 : Number(mRaw);
  const s = sRaw === "" ? 0 : Number(sRaw);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return undefined;
  if (!Number.isInteger(m) || !Number.isInteger(s)) return undefined;
  if (m < 0 || m > 59 || s < 0 || s > 59) return undefined;
  return m * 60 + s;
}

function updateTick() {
  if (!activeSession) return;
  const now = performance.now();
  const elapsed = now - activeSession.start;
  elapsedValue.textContent = formatElapsed(elapsed);

  const targetSec = loadTargetDurationSec();
  if (targetSec === null) {
    targetLine.hidden = true;
    targetLine.textContent = "";
  } else {
    const targetMs = targetSec * 1000;
    targetLine.hidden = false;
    if (elapsed < targetMs) {
      const remain = targetMs - elapsed;
      targetLine.textContent = `${formatElapsed(remain)} to target (${formatElapsed(targetMs)})`;
      targetLine.classList.remove("is-over");
    } else {
      const over = elapsed - targetMs;
      targetLine.textContent = `${formatElapsed(over)} past target`;
      targetLine.classList.add("is-over");
    }
  }
}

function startSession() {
  activeSession = { start: performance.now() };
  mainBtn.classList.add("is-active");
  mainBtn.setAttribute("aria-pressed", "true");
  elapsedWrap.hidden = false;
  updateTick();
  tickId = window.setInterval(updateTick, 250);
  syncMainButtonLabel();
}

async function endSession() {
  if (!activeSession) return;
  const endPerformance = performance.now();
  const durationMs = endPerformance - activeSession.start;
  const endWall = Date.now();

  if (tickId !== null) {
    clearInterval(tickId);
    tickId = null;
  }

  const durationSec = Math.max(0, Math.round(durationMs / 1000));
  const entry = {
    id: newEntryId(),
    endMs: endWall,
    intensity: getIntensityForNextEntry(),
    durationSec,
  };

  if (useCloud()) {
    try {
      await cloudInsert(entry);
    } catch (e) {
      console.error(e);
      setSyncMessage("Could not save contraction.", true);
      activeSession = null;
      mainBtn.classList.remove("is-active");
      elapsedWrap.hidden = true;
      syncMainButtonLabel();
      return;
    }
    cloudContractions.unshift(entry);
    cloudContractions.sort((a, b) => b.endMs - a.endMs);
    cloudContractions = cloudContractions.slice(0, 100);
    setSyncMessage("");
  } else {
    const list = loadContractionsFromLocalStorage();
    list.unshift(entry);
    saveContractionsToLocalStorage(list);
  }
  saveLastIntensity(entry.intensity);

  activeSession = null;
  mainBtn.classList.remove("is-active");
  mainBtn.setAttribute("aria-pressed", "false");
  elapsedWrap.hidden = true;
  targetLine.hidden = true;
  targetLine.classList.remove("is-over");

  renderHistory();
  renderStats();
  syncMainButtonLabel();
}

mainBtn.addEventListener("click", async () => {
  if (!appReady) return;
  if (loadLiveTimer()) {
    if (activeSession) await endSession();
    else startSession();
  } else {
    const entry = {
      id: newEntryId(),
      endMs: Date.now(),
      intensity: getIntensityForNextEntry(),
      durationSec: null,
    };
    if (useCloud()) {
      try {
        await cloudInsert(entry);
      } catch (e) {
        console.error(e);
        setSyncMessage("Could not save contraction.", true);
        return;
      }
      cloudContractions.unshift(entry);
      cloudContractions.sort((a, b) => b.endMs - a.endMs);
      cloudContractions = cloudContractions.slice(0, 100);
      setSyncMessage("");
    } else {
      const list = loadContractionsFromLocalStorage();
      list.unshift(entry);
      saveContractionsToLocalStorage(list);
    }
    saveLastIntensity(entry.intensity);
    renderHistory();
    renderStats();
  }
});

function renderHistory() {
  const items = loadContractions();
  historyList.innerHTML = "";
  historyEmpty.hidden = items.length > 0;
  clearAllBtn.hidden = items.length === 0;

  const total = items.length;
  const totalPages = total <= 0 ? 0 : Math.ceil(total / CONTRACTIONS_PAGE_SIZE);
  if (totalPages <= 0) {
    contractionsPage = 0;
  } else {
    contractionsPage = Math.max(0, Math.min(contractionsPage, totalPages - 1));
  }

  if (contractionsPageLabel) {
    contractionsPageLabel.textContent = totalPages <= 1 ? "" : `Page ${contractionsPage + 1} / ${totalPages}`;
  }
  if (contractionsPrevPageBtn) contractionsPrevPageBtn.disabled = totalPages <= 1 || contractionsPage <= 0;
  if (contractionsNextPageBtn) contractionsNextPageBtn.disabled = totalPages <= 1 || contractionsPage >= totalPages - 1;

  const start = contractionsPage * CONTRACTIONS_PAGE_SIZE;
  const pageItems = items.slice(start, start + CONTRACTIONS_PAGE_SIZE);

  for (let idx = 0; idx < pageItems.length; idx++) {
    const c = pageItems[idx];
    const older = pageItems[idx + 1];

    const li = document.createElement("li");
    li.className = "history-item";

    if (older) {
      const gapInfo = describeGapSincePrior(older, c);
      const gapRow = document.createElement("div");
      gapRow.className = "history-since-prior";
      gapRow.title = gapInfo.title;
      const lab = document.createElement("span");
      lab.className = "history-since-prior-label";
      lab.textContent = "Since prior";
      const val = document.createElement("span");
      val.className = "history-since-prior-value";
      val.textContent = gapInfo.text;
      gapRow.append(lab, val);
      li.appendChild(gapRow);
    }

    const rowInt = document.createElement("div");
    rowInt.className = "history-item-row history-item-row--intensity";
    for (let i = 1; i <= 10; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "history-int-btn";
      b.textContent = String(i);
      b.setAttribute("aria-pressed", i === c.intensity ? "true" : "false");
      b.setAttribute("aria-label", `Intensity ${i} of 10`);
      const ii = i;
      b.addEventListener("click", () => {
        void updateContraction(c.id, { intensity: ii });
        if (idx === 0) saveLastIntensity(ii);
      });
      rowInt.appendChild(b);
    }
    li.appendChild(rowInt);

    const rowMeta = document.createElement("div");
    rowMeta.className = "history-item-row history-item-row--meta";

    if (editingTimeId === c.id) {
      rowMeta.classList.add("history-item-row--edit");
      const wrap = document.createElement("div");
      wrap.className = "history-meta-edit";
      const input = document.createElement("input");
      input.type = "time";
      input.step = "1";
      input.className = "history-time-input";
      input.value = toTimeInputValue(c.endMs);
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "history-pill-btn history-pill-btn--primary";
      apply.textContent = "OK";
      apply.addEventListener("click", () => {
        editingTimeId = null;
        void updateContraction(c.id, { endMs: applyTimeStringToEndMs(c.endMs, input.value) });
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "history-pill-btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        editingTimeId = null;
        renderHistory();
      });
      wrap.append(input, apply, cancel);
      rowMeta.appendChild(wrap);
    } else if (editingDurationId === c.id) {
      rowMeta.classList.add("history-item-row--edit");
      const edit = document.createElement("div");
      edit.className = "history-duration-edit-inline";

      const mWrap = document.createElement("div");
      mWrap.className = "history-mini-wrap";
      const minIn = document.createElement("input");
      minIn.type = "number";
      minIn.inputMode = "numeric";
      minIn.min = "0";
      minIn.max = "59";
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

      if (c.durationSec != null) {
        minIn.value = String(Math.floor(c.durationSec / 60));
        secIn.value = String(c.durationSec % 60);
      }

      mWrap.append(minIn, mLab);
      sWrap.append(secIn, sLab);
      edit.append(mWrap, sWrap);

      const done = document.createElement("button");
      done.type = "button";
      done.className = "history-pill-btn history-pill-btn--primary";
      done.textContent = "OK";
      done.addEventListener("click", () => {
        const v = parseInlineDurationValue(minIn, secIn);
        if (v === undefined) return;
        editingDurationId = null;
        void updateContraction(c.id, { durationSec: v });
      });

      const clearDur = document.createElement("button");
      clearDur.type = "button";
      clearDur.className = "history-pill-btn";
      clearDur.textContent = "Clear";
      clearDur.addEventListener("click", () => {
        editingDurationId = null;
        void updateContraction(c.id, { durationSec: null });
      });

      const cancelDur = document.createElement("button");
      cancelDur.type = "button";
      cancelDur.className = "history-pill-btn";
      cancelDur.textContent = "Cancel";
      cancelDur.addEventListener("click", () => {
        editingDurationId = null;
        renderHistory();
      });

      edit.append(done, clearDur, cancelDur);
      rowMeta.appendChild(edit);
    } else {
      const timeBtn = document.createElement("button");
      timeBtn.type = "button";
      timeBtn.className = "history-meta-btn history-meta-btn--time";
      timeBtn.textContent = formatTimeOnly(c.endMs);
      timeBtn.setAttribute("aria-label", "Edit time");
      timeBtn.addEventListener("click", () => {
        editingTimeId = c.id;
        editingDurationId = null;
        renderHistory();
      });

      const sep = document.createElement("span");
      sep.className = "history-meta-sep";
      sep.textContent = "·";
      sep.setAttribute("aria-hidden", "true");

      const durBtn = document.createElement("button");
      durBtn.type = "button";
      durBtn.className = `history-meta-btn history-meta-btn--dur${c.durationSec == null ? " is-placeholder" : ""}`;
      durBtn.textContent = c.durationSec == null ? "—" : formatDuration(c.durationSec * 1000);
      durBtn.title = c.durationSec == null ? "Set duration (optional)" : "Edit duration";
      durBtn.addEventListener("click", () => {
        editingDurationId = c.id;
        editingTimeId = null;
        renderHistory();
      });

      const spacer = document.createElement("span");
      spacer.className = "history-meta-spacer";

      const del = document.createElement("button");
      del.type = "button";
      del.className = "history-icon-btn history-delete-btn";
      del.textContent = "×";
      del.setAttribute("aria-label", "Remove contraction");
      del.addEventListener("click", () => void removeContraction(c.id));

      rowMeta.append(timeBtn, sep, durBtn, spacer, del);
    }

    li.appendChild(rowMeta);
    historyList.appendChild(li);
  }
}

function renderStats() {
  const items = loadContractions();
  const result = computeAverageIntervalLastFive(items);
  if (result === null) {
    avgIntervalEl.textContent = "—";
    if (items.length < 2) {
      avgIntervalHint.textContent =
        "Log at least two contractions to measure time between them (last five used).";
    } else {
      avgIntervalHint.textContent =
        "Intervals could not be computed — check that times are in order.";
    }
    return;
  }
  avgIntervalEl.textContent = formatInterval(result.avgMs);
  const { gapCount, entryCount } = result;
  avgIntervalHint.textContent =
    gapCount === 1
      ? `Average of 1 interval from your ${entryCount} most recent entries (same rules as “Since prior” in the list).`
      : `Average of ${gapCount} intervals from your ${entryCount} most recent entries (same rules as “Since prior” in the list).`;
}

liveTimerToggle.addEventListener("change", () => {
  const on = liveTimerToggle.checked;
  saveLiveTimer(on);
  if (!on) abortLiveSession();
  syncMainButtonLabel();
  syncTimerModeHint();
});

clearAllBtn.addEventListener("click", () => void clearAllContractions());

contractionsPrevPageBtn?.addEventListener("click", () => {
  contractionsPage = Math.max(0, contractionsPage - 1);
  renderHistory();
});
contractionsNextPageBtn?.addEventListener("click", () => {
  const totalPages = loadContractions().length <= 0 ? 0 : Math.ceil(loadContractions().length / CONTRACTIONS_PAGE_SIZE);
  contractionsPage = Math.min(Math.max(0, totalPages - 1), contractionsPage + 1);
  renderHistory();
});

openOptionsBtn.addEventListener("click", () => openOptionsForm());

optionsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  saveOptionsFromForm();
  optionsDialog.close();
});

clearTargetBtn.addEventListener("click", () => {
  targetMinutesInput.value = "";
  targetSecondsInput.value = "";
  saveTargetDurationSec(null);
});

optionsDialog.addEventListener("click", (e) => {
  if (e.target === optionsDialog) optionsDialog.close();
});

loginForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void submitLogin();
});

loginDialog?.addEventListener("cancel", (e) => {
  e.preventDefault();
});

signOutBtn?.addEventListener("click", () => void signOutCloud());
reloadBtn?.addEventListener("click", () => {
  // iOS home-screen web apps do not expose a reload affordance.
  window.location.reload();
});

async function signOutCloud() {
  if (!supabase) return;
  teardownContractionsRealtime();
  await supabase.auth.signOut();
  cloudContractions = [];
  updateSignOutVisibility(false);
  optionsDialog.close();
  renderHistory();
  renderStats();
  setSyncMessage("Sign in to sync your list.");
  showLoginModal();
}

async function bootstrap() {
  document.body.classList.add("app-loading");
  setSyncMessage("");
  try {
    if (useCloud()) {
      setSyncMessage("Loading your data…");
      supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
      supabase.auth.onAuthStateChange((event) => {
        if (!useCloud()) return;
        if (event === "SIGNED_OUT") {
          teardownContractionsRealtime();
          cloudContractions = [];
          updateSignOutVisibility(false);
          if (appReady) {
            renderHistory();
            renderStats();
          }
          setSyncMessage("Sign in to sync your list.");
          if (loginDialog && typeof loginDialog.showModal === "function" && !loginDialog.open) {
            showLoginModal();
          }
        }
      });
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        await pullCloudContractions();
        await migrateLocalToCloudIfNeeded();
        setSyncMessage("");
        updateSignOutVisibility(true);
        if (session.user?.id) subscribeContractionsRealtime(session.user.id);
      } else {
        setSyncMessage("Sign in to sync your list.");
        updateSignOutVisibility(false);
        showLoginModal();
      }
    }
  } catch (e) {
    console.error(e);
    setSyncMessage(
      "Cloud sync failed — check supabase-config.js, schema, and that Email provider allows password sign-in.",
      true
    );
    cloudContractions = [];
  } finally {
    appReady = true;
    document.body.classList.remove("app-loading");
  }

  liveTimerToggle.checked = loadLiveTimer();
  syncTimerModeHint();
  syncMainButtonLabel();
  renderHistory();
  renderStats();
}

void bootstrap();
