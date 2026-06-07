/**
 * Sleep sessions data access + realtime sync.
 *
 * Table: public.sleeps
 * Columns: id, user_id, started_at_ms, ended_at_ms, quick_log
 *
 * A session with ended_at_ms === null is "in progress" (baby is asleep now).
 */

/**
 * @typedef {Object} SleepRow
 * @property {string} id
 * @property {number} startedAtMs
 * @property {number | null} endedAtMs
 * @property {boolean} quickLog
 */

/**
 * @param {Record<string, unknown>} r
 * @returns {SleepRow | null}
 */
function normalizeSleepRow(r) {
  if (!r || typeof r.id !== "string") return null;
  const startedAtMs = Number(r.started_at_ms);
  const endedAtMs = r.ended_at_ms == null ? null : Number(r.ended_at_ms);
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  if (endedAtMs != null && (!Number.isFinite(endedAtMs) || endedAtMs < startedAtMs)) return null;

  return {
    id: r.id,
    startedAtMs,
    endedAtMs,
    quickLog: Boolean(r.quick_log),
  };
}

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* ignore */
    }
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

const SELECT_COLUMNS = "id, started_at_ms, ended_at_ms, quick_log";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<SleepRow[]>}
 */
export async function pullSleeps(supabase) {
  const { data, error } = await supabase
    .from("sleeps")
    .select(SELECT_COLUMNS)
    .order("started_at_ms", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || [])
    .map((r) => normalizeSleepRow(/** @type {Record<string, unknown>} */ (r)))
    .filter(Boolean)
    .sort((a, b) => /** @type {SleepRow} */ (b).startedAtMs - /** @type {SleepRow} */ (a).startedAtMs);
}

/**
 * Pull sleep sessions that overlap the half-open interval [startMs, endMs).
 * A session overlaps a day if it starts before the day ends AND
 * (it has no end yet, or it ends after the day starts) — this correctly
 * includes sessions that span midnight.
 *
 * Returned in ascending start-time order — suitable for timeline rendering.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {number} startMs - inclusive lower bound (e.g. local midnight)
 * @param {number} endMs   - exclusive upper bound (e.g. next local midnight)
 * @returns {Promise<SleepRow[]>}
 */
export async function pullSleepsForDay(supabase, startMs, endMs) {
  const { data, error } = await supabase
    .from("sleeps")
    .select(SELECT_COLUMNS)
    .lt("started_at_ms", endMs)
    .or(`ended_at_ms.is.null,ended_at_ms.gte.${startMs}`)
    .order("started_at_ms", { ascending: true });
  if (error) throw error;
  return (data || [])
    .map((r) => normalizeSleepRow(/** @type {Record<string, unknown>} */ (r)))
    .filter(Boolean);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ startedAtMs: number, endedAtMs?: number | null, quickLog?: boolean }} input
 * @returns {Promise<SleepRow>}
 */
export async function insertSleep(supabase, input) {
  const {
    data: { user },
    error: uerr,
  } = await supabase.auth.getUser();
  if (uerr || !user) throw uerr || new Error("Not signed in");

  const id = newId();
  const row = {
    id,
    user_id: user.id,
    started_at_ms: Math.floor(input.startedAtMs),
    ended_at_ms: input.endedAtMs == null ? null : Math.floor(input.endedAtMs),
    quick_log: Boolean(input.quickLog),
  };

  const { error } = await supabase.from("sleeps").insert(row);
  if (error) throw error;

  return {
    id,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    quickLog: row.quick_log,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} id
 * @param {{ startedAtMs?: number, endedAtMs?: number | null }} patch
 */
export async function updateSleep(supabase, id, patch) {
  const row = /** @type {Record<string, unknown>} */ ({});
  if (typeof patch.startedAtMs === "number" && Number.isFinite(patch.startedAtMs)) {
    row.started_at_ms = Math.floor(patch.startedAtMs);
  }
  if ("endedAtMs" in patch) {
    row.ended_at_ms = patch.endedAtMs == null ? null : Math.floor(patch.endedAtMs);
  }
  const { error } = await supabase.from("sleeps").update(row).eq("id", id);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} id
 */
export async function deleteSleep(supabase, id) {
  const { error } = await supabase.from("sleeps").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Delete all sleep sessions for the currently signed-in user.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function deleteAllSleepsForUser(supabase) {
  const {
    data: { user },
    error: uerr,
  } = await supabase.auth.getUser();
  if (uerr || !user) throw uerr || new Error("Not signed in");
  const { error } = await supabase.from("sleeps").delete().eq("user_id", user.id);
  if (error) throw error;
}

/**
 * Subscribe to live changes.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {(next: SleepRow[]) => void} setList
 * @param {() => SleepRow[]} getList
 * @param {(msg: string, isError?: boolean) => void} setStatus
 * @returns {() => void} unsubscribe
 */
export function subscribeSleepsRealtime(supabase, userId, setList, getList, setStatus) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  /** @type {import("@supabase/supabase-js").RealtimeChannel | null} */
  let chan = null;
  let closed = false;
  let attempts = 0;

  function clearRetry() {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function backoffMs(n) {
    const base = Math.min(30_000, 500 * Math.pow(2, Math.max(0, n)));
    const jitter = Math.floor(Math.random() * 250);
    return base + jitter;
  }

  function scheduleRetry(reason) {
    if (closed) return;
    clearRetry();
    attempts += 1;
    const wait = backoffMs(attempts);
    console.warn("Realtime: scheduling retry", { reason, attempts, wait });
    if (attempts >= 3) {
      setStatus("Live sync is reconnecting…", true);
    }
    retryTimer = setTimeout(() => {
      if (closed) return;
      connect();
    }, wait);
  }

  function onPayload(payload) {
    const list = getList().slice();
    const ev = payload.eventType;
    if (ev === "INSERT" || ev === "UPDATE") {
      const row = normalizeSleepRow(/** @type {Record<string, unknown>} */ (payload.new));
      if (!row) return;
      const i = list.findIndex((x) => x.id === row.id);
      if (i === -1) list.unshift(row);
      else list[i] = row;
    } else if (ev === "DELETE") {
      const oldRow = /** @type {Record<string, unknown> | undefined} */ (payload.old);
      const id = oldRow && typeof oldRow.id === "string" ? oldRow.id : null;
      if (id) {
        const next = list.filter((x) => x.id !== id);
        setList(next);
        return;
      }
    }
    list.sort((a, b) => b.startedAtMs - a.startedAtMs);
    setList(list.slice(0, 100));
  }

  function connect() {
    if (closed) return;
    clearRetry();
    if (chan) {
      try {
        void supabase.removeChannel(chan);
      } catch {
        /* ignore */
      }
      chan = null;
    }

    chan = supabase
      .channel(`sleeps:${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sleeps", filter: `user_id=eq.${userId}` }, onPayload)
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          attempts = 0;
          setStatus("");
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          console.warn("Realtime:", status, err);
          scheduleRetry(status);
        }
      });
  }

  connect();

  return () => {
    closed = true;
    clearRetry();
    if (chan) void supabase.removeChannel(chan);
    chan = null;
  };
}
