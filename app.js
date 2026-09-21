const STORAGE_KEY = "shopping-list-state-v1";
const UNDO_MS = 4000;
const LONG_PRESS_MS = 420;
const RESET_PRESS_MS = 760;
const MOVE_TOLERANCE = 9;

const app = document.querySelector("#app");
const emptyState = document.querySelector("#emptyState");
const importButton = document.querySelector("#importButton");
const fallback = document.querySelector("#fallback");
const pasteInput = document.querySelector("#pasteInput");
const pasteConfirm = document.querySelector("#pasteConfirm");
const preview = document.querySelector("#preview");
const previewInput = document.querySelector("#previewInput");
const previewConfirm = document.querySelector("#previewConfirm");
const list = document.querySelector("#shoppingList");
const progressFill = document.querySelector("#progressFill");
const undo = document.querySelector("#undo");
const undoButton = document.querySelector("#undoButton");
const resetConfirm = document.querySelector("#resetConfirm");
const resetCancel = document.querySelector("#resetCancel");
const resetImport = document.querySelector("#resetImport");

let state = {
  items: [],
  originalCount: 0
};

let wakeLock = null;
let wakeIntent = false;
let undoTimer = 0;
let lastRemoved = null;
let completingIds = new Set();
let suppressNextClick = false;
let drag = null;
let press = null;
let resetPress = null;

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function splitClipboardText(text) {
  return text
    .replace(/\r/g, "\n")
    .split(/[\n,]+/)
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function parseItem(rawValue) {
  const raw = normalizeWhitespace(rawValue);
  const fraction = String.raw`(?:\d+(?:[./]\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])`;
  const approx = String.raw`(?:about|approx\.?|approximately|around|roughly)\s+`;
  const measureUnits = String.raw`(?:kg|g|mg|lb|lbs|oz|l|L|ml|mL|litres?|liters?)`;
  const countUnits = String.raw`(?:bottles?|cans?|tins?|packets?|packs?|bags?|boxes?|jars?|loaves|loaf|bunches|heads?|pieces?|pcs?|cloves?|slices?|dozen)`;
  const patterns = [
    new RegExp(String.raw`^(?<quantity>(?:${approx})?${fraction}\s*${measureUnits})\s+(?<name>.+)$`, "u"),
    new RegExp(String.raw`^(?<quantity>(?:${approx})?${fraction}\s+${countUnits})\s+(?<name>.+)$`, "iu"),
    new RegExp(String.raw`^(?<quantity>(?:${approx})?${fraction}\s*[x×])\s+(?<name>.+)$`, "iu"),
    new RegExp(String.raw`^(?<quantity>(?:${approx})?${fraction})\s+(?<name>.+)$`, "iu")
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && match.groups.name.trim()) {
      const quantity = match.groups.quantity
        .replace(/\s*([x×])$/iu, "x")
        .replace(/\s+/g, " ")
        .trim();
      return {
        id: createId(),
        raw,
        quantity,
        name: match.groups.name.trim()
      };
    }
  }

  return {
    id: createId(),
    raw,
    quantity: "",
    name: raw
  };
}

function parseList(text) {
  const parts = splitClipboardText(text);
  return parts.map(parseItem);
}

function saveState() {
  if (!state.items.length) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || !Array.isArray(saved.items) || !saved.items.length) {
      return false;
    }
    state = {
      items: saved.items.filter((item) => item && item.id && item.name),
      originalCount: Math.max(Number(saved.originalCount) || saved.items.length, saved.items.length)
    };
    return state.items.length > 0;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
}

function itemTemplate(item) {
  const label = item.quantity ? `${item.quantity} ${item.name}` : item.name;
  const content = item.quantity
    ? `<span class="quantity">${escapeHtml(item.quantity)}</span><span class="separator" aria-hidden="true">•</span><span class="name">${escapeHtml(item.name)}</span>`
    : `<span class="name">${escapeHtml(item.name)}</span>`;

  return `
    <li class="item" data-id="${item.id}">
      <button class="item-card" type="button" aria-label="${escapeHtml(label)}">${content}</button>
    </li>
  `;
}

function renderList() {
  list.innerHTML = state.items.map(itemTemplate).join("");
  app.classList.toggle("is-empty", !state.items.length);
  emptyState.classList.toggle("hidden", state.items.length > 0);
  fallback.classList.add("hidden");
  preview.classList.add("hidden");
  updateProgress();
}

function updateProgress() {
  const total = Math.max(state.originalCount, state.items.length, 0);
  const completed = Math.max(total - state.items.length, 0);
  const ratio = total ? completed / total : 0;
  progressFill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

function measureItems() {
  return new Map([...list.children].map((element) => [element.dataset.id, element.getBoundingClientRect()]));
}

function animateFrom(first, options = {}) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    return;
  }

  for (const element of list.children) {
    if (options.excludeId && element.dataset.id === options.excludeId) {
      continue;
    }
    const before = first.get(element.dataset.id);
    if (!before) {
      element.animate(
        [
          { opacity: 0, transform: "translate3d(0, 10px, 0) scale(0.985)" },
          { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }
        ],
        { duration: 210, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
      continue;
    }
    const after = element.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (!dx && !dy) {
      continue;
    }
    element.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0)` },
        { transform: "translate3d(0, 0, 0)" }
      ],
      { duration: 260, easing: "cubic-bezier(.2,.9,.2,1)" }
    );
  }
}

function beginList(items) {
  state = {
    items,
    originalCount: items.length
  };
  lastRemoved = null;
  hideUndo();
  saveState();
  renderList();
  requestWakeLock();
}

function showFallback() {
  emptyState.classList.add("hidden");
  preview.classList.add("hidden");
  fallback.classList.remove("hidden");
  requestAnimationFrame(() => pasteInput.focus());
}

function showPreview(text) {
  emptyState.classList.add("hidden");
  fallback.classList.add("hidden");
  previewInput.value = text;
  preview.classList.remove("hidden");
  requestAnimationFrame(() => previewInput.focus());
}

function handleImportText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    showFallback();
    return;
  }

  const items = parseList(trimmed);
  const looksUnsplit = items.length === 1 && trimmed.length > 120 && !/[\n,]/.test(trimmed);
  if (!items.length || looksUnsplit) {
    showPreview(splitClipboardText(trimmed).join("\n") || trimmed);
    return;
  }

  beginList(items);
}

async function importFromClipboard() {
  wakeIntent = true;
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      throw new Error("Clipboard API unavailable");
    }
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      throw new Error("Clipboard was empty");
    }
    handleImportText(text);
  } catch {
    showFallback();
  }
}

async function requestWakeLock() {
  wakeIntent = true;
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") {
    return;
  }
  try {
    if (wakeLock) {
      return;
    }
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function vibrate() {
  if (navigator.vibrate) {
    navigator.vibrate(8);
  }
}

function completeItem(id) {
  if (completingIds.has(id) || drag) {
    return;
  }
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) {
    return;
  }
  const element = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  const card = element?.querySelector(".item-card");
  if (!card) {
    return;
  }

  completingIds.add(id);
  card.classList.add("completing");
  vibrate();

  window.setTimeout(() => {
    const first = measureItems();
    const [item] = state.items.splice(index, 1);
    lastRemoved = { item, index };
    completingIds.delete(id);
    saveState();
    renderList();
    animateFrom(first);

    if (!state.items.length) {
      hideUndo();
      window.setTimeout(resetToInitial, 280);
    } else {
      showUndo();
    }
  }, 190);
}

function showUndo() {
  window.clearTimeout(undoTimer);
  undo.classList.remove("hidden");
  undoTimer = window.setTimeout(hideUndo, UNDO_MS);
}

function hideUndo() {
  window.clearTimeout(undoTimer);
  undo.classList.add("hidden");
}

function restoreLastRemoved() {
  if (!lastRemoved) {
    return;
  }
  const first = measureItems();
  const index = Math.min(lastRemoved.index, state.items.length);
  state.items.splice(index, 0, lastRemoved.item);
  lastRemoved = null;
  hideUndo();
  saveState();
  renderList();
  animateFrom(first);
}

function resetToInitial() {
  state = { items: [], originalCount: 0 };
  completingIds.clear();
  lastRemoved = null;
  hideUndo();
  localStorage.removeItem(STORAGE_KEY);
  renderList();
  wakeIntent = false;
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function reorderStateFromDom() {
  const byId = new Map(state.items.map((item) => [item.id, item]));
  state.items = [...list.children].map((element) => byId.get(element.dataset.id)).filter(Boolean);
  saveState();
}

function startDrag(element, event) {
  if (drag || completingIds.has(element.dataset.id)) {
    return;
  }
  const rect = element.getBoundingClientRect();
  drag = {
    id: element.dataset.id,
    element,
    pointerId: event.pointerId,
    originY: rect.top,
    grabOffsetY: event.clientY - rect.top,
    pointerY: event.clientY
  };
  suppressNextClick = true;
  element.classList.add("is-dragging");
  element.style.width = `${rect.width}px`;
  element.querySelector(".item-card")?.classList.remove("is-pressed");
  try {
    element.setPointerCapture?.(event.pointerId);
  } catch {
    // Pointer capture is a polish enhancement; dragging still works without it.
  }
  moveDrag(event);
}

function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  event.preventDefault();
  drag.pointerY = event.clientY;
  drag.element.style.transform = `translate3d(0, ${drag.pointerY - drag.originY - drag.grabOffsetY}px, 0)`;

  const first = measureItems();
  const siblings = [...list.children].filter((child) => child !== drag.element);
  const next = siblings.find((child) => {
    const rect = child.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });

  if (next !== drag.element.nextElementSibling) {
    const beforeDrag = drag.element.getBoundingClientRect();
    list.insertBefore(drag.element, next || null);
    const afterDrag = drag.element.getBoundingClientRect();
    drag.originY += afterDrag.top - beforeDrag.top;
    drag.element.style.transform = `translate3d(0, ${drag.pointerY - drag.originY - drag.grabOffsetY}px, 0)`;
    animateFrom(first, { excludeId: drag.id });
  }
}

function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  const element = drag.element;
  try {
    element.releasePointerCapture?.(event.pointerId);
  } catch {
    // Ignore capture mismatches from browsers that drop capture during scrolling.
  }
  element.classList.remove("is-dragging");
  element.style.transform = "";
  element.style.width = "";
  drag = null;
  reorderStateFromDom();
  window.setTimeout(() => {
    suppressNextClick = false;
  }, 260);
}

function cancelPress() {
  if (!press) {
    return;
  }
  window.clearTimeout(press.timer);
  press.element.querySelector(".item-card")?.classList.remove("is-pressed");
  press = null;
}

function handlePointerDown(event) {
  const element = event.target.closest(".item");
  if (!element || !list.contains(element)) {
    return;
  }
  const card = element.querySelector(".item-card");
  card?.classList.add("is-pressed");
  press = {
    element,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    startX: event.clientX,
    startY: event.clientY,
    timer: 0
  };

  if (event.pointerType !== "mouse") {
    press.timer = window.setTimeout(() => startDrag(element, event), LONG_PRESS_MS);
  }
}

function handlePointerMove(event) {
  if (drag) {
    moveDrag(event);
    return;
  }
  if (!press || event.pointerId !== press.pointerId) {
    return;
  }
  const dx = event.clientX - press.startX;
  const dy = event.clientY - press.startY;
  const distance = Math.hypot(dx, dy);
  if (press.pointerType === "mouse" && distance > 5) {
    window.clearTimeout(press.timer);
    startDrag(press.element, event);
    press = null;
    return;
  }
  if (distance > MOVE_TOLERANCE) {
    cancelPress();
  }
}

function handlePointerUp(event) {
  if (drag) {
    endDrag(event);
    return;
  }
  if (press && event.pointerId === press.pointerId) {
    cancelPress();
  }
}

function handleCardClick(event) {
  const card = event.target.closest(".item-card");
  if (!card) {
    return;
  }
  if (suppressNextClick) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const element = card.closest(".item");
  completeItem(element.dataset.id);
}

function showResetConfirm() {
  if (!state.items.length) {
    return;
  }
  resetConfirm.classList.remove("hidden");
  resetCancel.focus();
}

function hideResetConfirm() {
  resetConfirm.classList.add("hidden");
}

function clearResetPress() {
  if (!resetPress) {
    return;
  }
  window.clearTimeout(resetPress.timer);
  resetPress = null;
}

function maybeStartBackgroundPress(event) {
  if (!state.items.length || event.target.closest(".item, button, textarea, .undo, .confirm")) {
    return;
  }
  resetPress = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    timer: window.setTimeout(showResetConfirm, RESET_PRESS_MS)
  };
}

function handleBackgroundMove(event) {
  if (!resetPress || event.pointerId !== resetPress.pointerId) {
    return;
  }
  const distance = Math.hypot(event.clientX - resetPress.startX, event.clientY - resetPress.startY);
  if (distance > MOVE_TOLERANCE) {
    clearResetPress();
  }
}

function importPreviewText() {
  const lines = previewInput.value
    .split(/\n+/)
    .map(normalizeWhitespace)
    .filter(Boolean);
  if (!lines.length) {
    showPreview(previewInput.value);
    return;
  }
  beginList(lines.map(parseItem));
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}

importButton.addEventListener("click", importFromClipboard);
pasteConfirm.addEventListener("click", () => handleImportText(pasteInput.value));
previewConfirm.addEventListener("click", importPreviewText);
undo.addEventListener("click", restoreLastRemoved);
list.addEventListener("click", handleCardClick);
list.addEventListener("pointerdown", handlePointerDown);
window.addEventListener("pointermove", handlePointerMove, { passive: false });
window.addEventListener("pointerup", handlePointerUp);
window.addEventListener("pointercancel", handlePointerUp);
document.addEventListener("pointerdown", maybeStartBackgroundPress);
document.addEventListener("pointermove", handleBackgroundMove);
document.addEventListener("pointerup", clearResetPress);
document.addEventListener("pointercancel", clearResetPress);
resetCancel.addEventListener("click", hideResetConfirm);
resetImport.addEventListener("click", () => {
  hideResetConfirm();
  resetToInitial();
  importFromClipboard();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wakeIntent && state.items.length) {
    requestWakeLock();
  }
});
document.addEventListener("pointerdown", () => {
  if (state.items.length && !wakeLock) {
    requestWakeLock();
  }
}, { passive: true });

if (loadState()) {
  renderList();
  requestWakeLock();
} else {
  renderList();
}

registerServiceWorker();
