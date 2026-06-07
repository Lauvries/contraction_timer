import { TOGGLEABLE_TABS, loadTabVisibility, saveTabVisibility, applyTabVisibility } from "./nav.js";

const tabList = document.getElementById("optionsTabList");

function render() {
  if (!tabList) return;
  const visibility = loadTabVisibility();
  tabList.innerHTML = "";

  for (const tab of TOGGLEABLE_TABS) {
    const li = document.createElement("li");

    const label = document.createElement("label");
    label.className = "toggle-label";

    const text = document.createElement("span");
    text.className = "toggle-text";
    text.textContent = tab.label;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "toggle-input";
    input.checked = visibility[tab.id] !== false;
    input.addEventListener("change", () => {
      const next = loadTabVisibility();
      next[tab.id] = input.checked;
      saveTabVisibility(next);
      applyTabVisibility();
    });

    const switchEl = document.createElement("span");
    switchEl.className = "toggle-switch";
    switchEl.setAttribute("aria-hidden", "true");

    label.append(text, input, switchEl);
    li.appendChild(label);
    tabList.appendChild(li);
  }
}

applyTabVisibility();
render();
