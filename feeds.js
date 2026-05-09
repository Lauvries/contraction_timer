/**
 * Feeds (breastfeeding) data access + realtime sync.
 *
 * Table: public.feeds
 * Columns: id, user_id, started_at_ms, side1, duration1_sec, side2, duration2_sec
 */

/** @typedef {"L"|"R"} BreastSide */

/**
 * @typedef {Object} FeedRow
 * @property {string} id
 * @property {number} startedAtMs
 * @property {BreastSide} side1
 * @property {number} duration1Sec
 * @property {BreastSide | null} side2
 * @property {number | null} duration2Sec
 */

/**
 * @param {unknown} v
 * @returns {BreastSide | null}
 */
function asSide(v) {
  if (v === "L" || v === "R") return v;
  return null;
}

/**
 * @param {Record<string, unknown>} r
 * @returns {FeedRow | null}
 */
function normalizeFeedRow(r) {
  if (!r || typeof r.id !== "string") return null;
  const startedAtMs = Number(r.started_at_ms);
  const side1 = asSide(r.side1);
  const duration1Sec = Number(r.duration1_sec);
  const side2 = r.side2 == null ? null : asSide(r.side2);
  const duration2Sec = r.duration2_sec == null ? null : Number(r.duration2_sec);
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  if (!side1) return null;
  if (!Number.isFinite(duration1Sec) || duration1Sec < 0) return null;
  if (side2 == null && r.side2 != null) return null;
  if (duration2Sec != null && (!Number.isFinite(duration2Sec) || duration2Sec < 0)) return null;

  return {
    id: r.id,
    startedAtMs,
    side1,
    duration1Sec: Math.floor(duration1Sec),
    side2,
    duration2Sec: duration2Sec == null ? null : Math.floor(duration2Sec),
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
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<FeedRow[]>}
 */
export async function pullFeeds(supabase) {
  const { data, error } = await supabase
    .from("feeds")
    .select("id, started_at_ms, side1, duration1_sec, side2, duration2_sec")
    .order("started_at_ms", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || [])
    .map((r) => normalizeFeedRow(/** @type {Record<string, unknown>} */ (r)))
    .filter(Boolean)
    .sort((a, b) => /** @type {FeedRow} */ (b).startedAtMs - /** @type {FeedRow} */ (a).startedAtMs);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ startedAtMs: number, side1: BreastSide, duration1Sec: number, side2?: BreastSide | null, duration2Sec?: number | null }} input
 * @returns {Promise<FeedRow>}
 */
export async function insertFeed(supabase, input) {
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
    side1: input.side1,
    duration1_sec: Math.max(0, Math.floor(input.duration1Sec)),
    side2: input.side2 ?? null,
    duration2_sec:
      input.duration2Sec == null || input.duration2Sec === undefined ? null : Math.max(0, Math.floor(input.duration2Sec)),
  };

  const { error } = await supabase.from("feeds").insert(row);
  if (error) throw error;

  return {
    id,
    startedAtMs: row.started_at_ms,
    side1: row.side1,
    duration1Sec: row.duration1_sec,
    side2: row.side2,
    duration2Sec: row.duration2_sec,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} id
 * @param {{ side2: BreastSide, duration2Sec: number }} patch
 */
export async function addSecondSide(supabase, id, patch) {
  const row = {
    side2: patch.side2,
    duration2_sec: Math.max(0, Math.floor(patch.duration2Sec)),
  };
  const { error } = await supabase.from("feeds").update(row).eq("id", id);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} id
 * @param {{ startedAtMs?: number, duration1Sec?: number, duration2Sec?: number | null }} patch
 */
export async function updateFeed(supabase, id, patch) {
  const row = /** @type {Record<string, unknown>} */ ({});
  if (typeof patch.startedAtMs === "number" && Number.isFinite(patch.startedAtMs)) {
    row.started_at_ms = Math.floor(patch.startedAtMs);
  }
  if (typeof patch.duration1Sec === "number" && Number.isFinite(patch.duration1Sec)) {
    row.duration1_sec = Math.max(0, Math.floor(patch.duration1Sec));
  }
  if ("duration2Sec" in patch) {
    row.duration2_sec =
      patch.duration2Sec == null || patch.duration2Sec === undefined ? null : Math.max(0, Math.floor(patch.duration2Sec));
  }
  const { error } = await supabase.from("feeds").update(row).eq("id", id);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} id
 */
export async function deleteFeed(supabase, id) {
  const { error } = await supabase.from("feeds").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Delete all feeds for the currently signed-in user.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function deleteAllFeedsForUser(supabase) {
  const {
    data: { user },
    error: uerr,
  } = await supabase.auth.getUser();
  if (uerr || !user) throw uerr || new Error("Not signed in");
  const { error } = await supabase.from("feeds").delete().eq("user_id", user.id);
  if (error) throw error;
}

/**
 * Subscribe to live changes.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {(next: FeedRow[]) => void} setList
 * @param {() => FeedRow[]} getList
 * @param {(msg: string, isError?: boolean) => void} setStatus
 * @returns {() => void} unsubscribe
 */
export function subscribeFeedsRealtime(supabase, userId, setList, getList, setStatus) {
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
    // 0.5s, 1s, 2s, 4s, ... capped, with a bit of jitter
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
    // Only show a warning if we keep failing for a while; transient drops are normal on mobile.
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
      const row = normalizeFeedRow(/** @type {Record<string, unknown>} */ (payload.new));
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
      .channel(`feeds:${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "feeds", filter: `user_id=eq.${userId}` }, onPayload)
      .subscribe((status, err) => {
        // Supabase Realtime status values are stringly-typed; handle the common ones we see on mobile.
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

  // Kick off initial connection.
  connect();

  return () => {
    closed = true;
    clearRetry();
    if (chan) void supabase.removeChannel(chan);
    chan = null;
  };
}

