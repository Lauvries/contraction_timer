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
 */
export async function deleteFeed(supabase, id) {
  const { error } = await supabase.from("feeds").delete().eq("id", id);
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
  const chan = supabase
    .channel(`feeds:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "feeds", filter: `user_id=eq.${userId}` },
      (payload) => {
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
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("Realtime:", status, err);
        setStatus("Live sync lost connection — refresh if the list looks wrong.", true);
      }
    });

  return () => {
    void supabase.removeChannel(chan);
  };
}

