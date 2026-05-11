/**
 * Pull-to-refresh for iOS home-screen web apps.
 *
 * Safari has native pull-to-refresh in-browser, but home-screen web apps often do not.
 * This implementation drags the whole `.app` container down and reloads on release.
 */
export function installPullToRefresh() {
  // Avoid double-install in case of hot reload or multiple imports.
  if (window.__pullToRefreshInstalled) return;
  window.__pullToRefreshInstalled = true;

  const app = document.querySelector(".app");
  if (!(app instanceof HTMLElement)) return;

  const el = document.createElement("div");
  el.className = "ptr-indicator";
  el.setAttribute("aria-hidden", "true");
  el.textContent = "Pull to refresh";
  document.body.appendChild(el);

  const THRESHOLD_PX = 88;
  const MAX_PX = 160;

  let startY = 0;
  let pulling = false;
  let current = 0;
  let armed = false;
  let animating = false;

  function isAtTop() {
    // In standalone mode, window.scrollY can be quirky; allow a tiny epsilon.
    if (window.scrollY > 1) return false;
    // If the user is actively scrolling a nested scroll container (history pane),
    // don't steal the gesture unless that container is also at the top.
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const scroller = active.closest(".app-panel--history");
      if (scroller instanceof HTMLElement && scroller.scrollTop > 0) return false;
    }
    return true;
  }

  function setPull(px, immediate) {
    current = Math.max(0, Math.min(MAX_PX, px));
    const y = Math.round(current);
    el.style.transform = `translate(-50%, ${-48 + y}px)`;
    app.style.transform = `translate3d(0, ${y}px, 0)`;
    app.style.transition = immediate ? "none" : "";
    el.classList.toggle("ptr-indicator--visible", current > 0);
    el.classList.toggle("ptr-indicator--ready", current >= THRESHOLD_PX);
    el.textContent = current >= THRESHOLD_PX ? "Release to refresh" : "Pull to refresh";
  }

  function snapBack() {
    if (animating) return;
    animating = true;
    app.style.transition = "transform 160ms ease";
    el.style.transition = "opacity 120ms ease";
    requestAnimationFrame(() => {
      setPull(0, true);
      // allow transition to finish before clearing
      setTimeout(() => {
        app.style.transition = "";
        el.style.transition = "";
        animating = false;
      }, 190);
    });
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      if (!isAtTop()) return;
      const t = e.touches[0];
      startY = t.clientY;
      pulling = true;
      armed = false;
      setPull(0);
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!pulling) return;
      if (e.touches.length !== 1) return;
      if (!isAtTop()) {
        pulling = false;
        snapBack();
        return;
      }
      const t = e.touches[0];
      const dy = t.clientY - startY;
      if (dy <= 0) {
        setPull(0, true);
        return;
      }
      // Prevent native rubber-band (and keep our drag smooth).
      e.preventDefault();
      const pullPx = dy * 0.65;
      setPull(pullPx, true);
      armed = current >= THRESHOLD_PX;
    },
    { passive: false }
  );

  document.addEventListener(
    "touchend",
    () => {
      if (!pulling) return;
      pulling = false;
      const shouldReload = armed;
      if (!shouldReload) {
        snapBack();
        return;
      }
      // Keep it slightly pulled while reloading.
      el.classList.add("ptr-indicator--visible");
      el.classList.remove("ptr-indicator--ready");
      el.textContent = "Refreshing…";
      app.style.transition = "transform 160ms ease";
      app.style.transform = `translate3d(0, ${Math.round(THRESHOLD_PX)}px, 0)`;
      setTimeout(() => window.location.reload(), 60);
    },
    { passive: true }
  );

  document.addEventListener(
    "touchcancel",
    () => {
      pulling = false;
      snapBack();
    },
    { passive: true }
  );
}

