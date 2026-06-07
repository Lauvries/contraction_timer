/**
 * Shared top-nav visibility.
 *
 * Each page's <nav class="top-nav"> lists every tab as an <a data-tab="...">.
 * The Options page lets the user hide tabs they don't use (e.g. Contractions);
 * this module reads that preference and hides the corresponding links + separators
 * on every page. "Options" itself is never hideable — it's the way back.
 */

const TAB_VISIBILITY_KEY = "tab_visibility_v1";

/** Tabs that can be toggled from the Options page, in nav order. */
export const TOGGLEABLE_TABS = [
  { id: "feeds", label: "Feeds" },
  { id: "contractions", label: "Contractions" },
  { id: "timeline", label: "Timeline" },
  { id: "sleep", label: "Sleep" },
];

/** @returns {Record<string, boolean>} */
export function loadTabVisibility() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const t of TOGGLEABLE_TABS) out[t.id] = true;
  try {
    const raw = localStorage.getItem(TAB_VISIBILITY_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const t of TOGGLEABLE_TABS) {
          if (typeof data[t.id] === "boolean") out[t.id] = data[t.id];
        }
      }
    }
  } catch {
    /* ignore — fall back to all-visible */
  }
  return out;
}

/** @param {Record<string, boolean>} visibility */
export function saveTabVisibility(visibility) {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const t of TOGGLEABLE_TABS) out[t.id] = visibility[t.id] !== false;
  localStorage.setItem(TAB_VISIBILITY_KEY, JSON.stringify(out));
}

/**
 * Hide nav links (and their following separator) for tabs the user turned off.
 * Safe to call on every page load — looks for `.top-nav [data-tab]`.
 */
export function applyTabVisibility() {
  const visibility = loadTabVisibility();
  const nav = document.querySelector(".top-nav");
  if (!nav) return;
  const links = nav.querySelectorAll("[data-tab]");
  links.forEach((link) => {
    const tab = link.getAttribute("data-tab");
    if (!tab) return;
    const visible = visibility[tab] !== false;
    link.toggleAttribute("hidden", !visible);
    const sep = link.nextElementSibling;
    if (sep && sep.classList.contains("top-nav-sep")) {
      sep.toggleAttribute("hidden", !visible);
    }
  });
  // If the active tab itself got hidden (user hid the page they're on), still show it
  // so navigation isn't confusing — but that only happens via direct link/bookmark,
  // and Options always remains reachable to turn it back on.
  normalizeSeparators(nav);
}

/** Hide a separator that would otherwise appear first/last/doubled after hiding links. */
function normalizeSeparators(nav) {
  for (const el of Array.from(nav.children)) {
    if (!el.classList.contains("top-nav-sep")) continue;
    // A separator is only meaningful between two visible links.
    const prevLink = el.previousElementSibling;
    const nextLink = el.nextElementSibling;
    const prevVisible = prevLink && prevLink.matches("[data-tab]") && !prevLink.hasAttribute("hidden");
    const nextVisible = nextLink && nextLink.matches("[data-tab]") && !nextLink.hasAttribute("hidden");
    el.toggleAttribute("hidden", !(prevVisible && nextVisible));
  }
}
