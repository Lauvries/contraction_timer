/**
 * Shared auth/bootstrap helpers.
 *
 * iOS PWAs can sometimes report `getSession()` as null briefly on startup even when a
 * persisted session exists. The `INITIAL_SESSION` auth event is the most reliable signal.
 */

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<import("@supabase/supabase-js").Session | null>}
 */
export async function waitForInitialSession(sb, opts) {
  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : 1500;

  return await new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let settled = false;

    /** @param {import("@supabase/supabase-js").Session | null | undefined} sess */
    const finish = (sess) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      try {
        sub?.unsubscribe?.();
      } catch {
        /* ignore */
      }
      resolve(sess || null);
    };

    // Attach listener first to avoid missing INITIAL_SESSION.
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        finish(session);
      } else if (event === "SIGNED_OUT") {
        finish(null);
      }
    });
    const sub = data?.subscription;

    timer = setTimeout(() => {
      void (async () => {
        try {
          const {
            data: { session },
          } = await sb.auth.getSession();
          finish(session);
        } catch {
          finish(null);
        }
      })();
    }, timeoutMs);
  });
}

