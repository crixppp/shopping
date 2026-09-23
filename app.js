const STORAGE_KEY = "shopping-list-state-v1";
const LONG_PRESS_MS = 420;
const RESET_PRESS_MS = 760;
const MOVE_TOLERANCE = 9;
const SWIPE_THRESHOLD = 82;
const SWIPE_MAX_PULL = 104;

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
const completeState = document.querySelector("#completeState");
const progressFill = document.querySelector("#progressFill");
const undoStatus = document.querySelector("#undoStatus");
const resetConfirm = document.querySelector("#resetConfirm");
const resetCancel = document.querySelector("#resetCancel");
const resetImport = document.querySelector("#resetImport");

let state = {
  items: [],
  originalCount: 0,
  removed: []
};

let wakeLock = null;
let wakeIntent = false;
let completingIds = new Set();
let suppressNextClick = false;
let drag = null;
let press = null;
let resetPress = null;
let undoSwipe = null;

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

function titleCase(value) {
  return value.replace(/(^|[\s/(-])(\p{L})/gu, (match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase()}`);
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
  if (!state.items.length && !state.removed.length) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const savedRemoved = Array.isArray(saved?.removed) ? saved.removed : [];
    if (!saved || !Array.isArray(saved.items) || (!saved.items.length && !savedRemoved.length)) {
      return false;
    }
    state = {
      items: saved.items.filter((item) => item && item.id && item.name),
      originalCount: Math.max(Number(saved.originalCount) || saved.items.length, saved.items.length),
      removed: savedRemoved.filter((entry) => entry?.item?.id && entry.item.name && Number.isFinite(entry.index))
    };
    state.originalCount = Math.max(state.originalCount, state.items.length + state.removed.length);
    return state.items.length > 0 || state.removed.length > 0;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
}

function itemTemplate(item) {
  const name = titleCase(item.name);
  const label = item.quantity ? `${item.quantity} ${name}` : name;
  const content = item.quantity
    ? `<span class="quantity">${escapeHtml(item.quantity)}</span><span class="separator" aria-hidden="true">•</span><span class="name">${escapeHtml(name)}</span>`
    : `<span class="name">${escapeHtml(name)}</span>`;

  return `
    <li class="item" data-id="${item.id}">
      <button class="item-card" type="button" aria-label="${escapeHtml(label)}">${content}</button>
    </li>
  `;
}

function renderList() {
  const hasActiveList = state.items.length > 0 || state.removed.length > 0;
  const isComplete = state.items.length === 0 && state.removed.length > 0;
  list.innerHTML = state.items.map(itemTemplate).join("");
  app.classList.toggle("is-empty", !hasActiveList);
  emptyState.classList.toggle("hidden", hasActiveList);
  completeState.classList.toggle("hidden", !isComplete);
  document.body.classList.toggle("can-undo", state.removed.length > 0);
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
        { duration: options.duration || 360, easing: "cubic-bezier(.22,1,.36,1)" }
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
      { duration: options.duration || 480, easing: "cubic-bezier(.22,1,.36,1)" }
    );
  }
}

function beginList(items) {
  state = {
    items,
    originalCount: items.length,
    removed: []
  };
  resetUndoVisual();
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

  window.setTimeout(() => {
    const currentIndex = state.items.findIndex((item) => item.id === id);
    if (currentIndex === -1) {
      completingIds.delete(id);
      return;
    }
    const first = measureItems();
    const [item] = state.items.splice(currentIndex, 1);
    state.removed.push({ item, index: currentIndex });
    completingIds.delete(id);
    saveState();
    renderList();
    animateFrom(first);
    undoStatus.textContent = `${titleCase(item.name)} removed`;
  }, 300);
}

function resetUndoVisual() {
  app.classList.remove("is-undo-pulling");
  app.style.removeProperty("transform");
}

function setUndoPull(pull) {
  const resisted = Math.min(SWIPE_MAX_PULL, pull * 0.58 + Math.sqrt(pull) * 1.7);
  const tremorProgress = Math.max(0, Math.min(1.35, (pull - 18) / (SWIPE_THRESHOLD - 18)));
  const tremor = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : Math.min(4.5, tremorProgress * 3.6);
  const x = Math.sin(pull * 0.64) * tremor;
  const rotation = Math.sin(pull * 0.43) * tremor * 0.07;
  const scale = 1 - Math.min(0.012, pull * 0.0001);
  const transform = `translate3d(${x.toFixed(2)}px, ${resisted.toFixed(2)}px, 0) rotate(${rotation.toFixed(3)}deg) scale(${scale.toFixed(4)})`;
  app.classList.add("is-undo-pulling");
  app.style.transform = transform;
  return { transform };
}

function animateUndoRelease(visual, activated) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    resetUndoVisual();
    return Promise.resolve();
  }

  const keyframes = activated
    ? [
        { transform: visual.transform },
        { transform: "translate3d(0, -8px, 0) scale(0.992)", offset: 0.44 },
        { transform: "translate3d(0, 4px, 0) scale(1.004)", offset: 0.72 },
        { transform: "translate3d(0, 0, 0) scale(1)" }
      ]
    : [
        { transform: visual.transform },
        { transform: "translate3d(0, -5px, 0) scale(0.996)", offset: 0.58 },
        { transform: "translate3d(0, 0, 0) scale(1)" }
      ];

  resetUndoVisual();
  return app.animate(keyframes, {
    duration: activated ? 430 : 300,
    easing: "cubic-bezier(.22,1,.36,1)"
  }).finished.catch(() => {});
}

function restoreLastRemoved() {
  const removed = state.removed.pop();
  if (!removed) {
    return false;
  }

  const first = measureItems();
  const index = Math.min(Math.max(removed.index, 0), state.items.length);
  state.items.splice(index, 0, removed.item);
  saveState();
  renderList();
  animateFrom(first);
  undoStatus.textContent = `${titleCase(removed.item.name)} restored`;
  return true;
}

function resetToInitial() {
  state = { items: [], originalCount: 0, removed: [] };
  completingIds.clear();
  undoSwipe = null;
  resetUndoVisual();
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
  undoSwipe = null;
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
    animateFrom(first, { excludeId: drag.id, duration: 260 });
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

  press.timer = window.setTimeout(() => {
    if (!press || press.pointerId !== event.pointerId) {
      return;
    }
    press = null;
    startDrag(element, event);
  }, LONG_PRESS_MS);
}

function handlePointerMove(event) {
  if (undoSwipe?.engaged) {
    cancelPress();
    return;
  }
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

function startUndoSwipe(event) {
  if (!state.removed.length || undoSwipe || event.button > 0 || !resetConfirm.classList.contains("hidden") || event.target.closest("textarea, .confirm")) {
    return;
  }
  undoSwipe = {
    pointerId: event.pointerId,
    source: event.target,
    startX: event.clientX,
    startY: event.clientY,
    visual: { transform: "translate3d(0, 0, 0)" },
    armed: false,
    engaged: false
  };
}

function moveUndoSwipe(event) {
  if (!undoSwipe || event.pointerId !== undoSwipe.pointerId) {
    return;
  }

  const dx = event.clientX - undoSwipe.startX;
  const dy = event.clientY - undoSwipe.startY;
  if (!undoSwipe.engaged && (dy < -MOVE_TOLERANCE || (Math.abs(dx) > Math.max(dy, 0) * 1.25 && Math.abs(dx) > MOVE_TOLERANCE))) {
    undoSwipe = null;
    return;
  }
  if (dy < MOVE_TOLERANCE) {
    return;
  }

  event.preventDefault();
  if (!undoSwipe.engaged) {
    undoSwipe.engaged = true;
    cancelPress();
    clearResetPress();
    try {
      undoSwipe.source.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level tracking still handles the gesture without capture.
    }
  }

  const pull = Math.max(0, dy);
  undoSwipe.visual = setUndoPull(pull);
  undoSwipe.armed = pull >= SWIPE_THRESHOLD;
}

function endUndoSwipe(event, cancelled = false) {
  if (!undoSwipe || event.pointerId !== undoSwipe.pointerId) {
    return;
  }

  const swipe = undoSwipe;
  undoSwipe = null;
  if (!swipe.engaged) {
    return;
  }

  const activated = !cancelled && swipe.armed;
  suppressNextClick = true;
  window.setTimeout(() => {
    suppressNextClick = false;
  }, 360);
  animateUndoRelease(swipe.visual, activated);

  if (activated) {
    restoreLastRemoved();
  }
}

function cancelUndoSwipe() {
  if (!undoSwipe) {
    return;
  }
  const swipe = undoSwipe;
  undoSwipe = null;
  if (swipe.engaged) {
    animateUndoRelease(swipe.visual, false);
  } else {
    resetUndoVisual();
  }
}

function showResetConfirm() {
  cancelUndoSwipe();
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
  if (!state.items.length || event.target.closest(".item, button, textarea, .confirm")) {
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
list.addEventListener("click", handleCardClick);
list.addEventListener("pointerdown", handlePointerDown);
list.addEventListener("contextmenu", (event) => event.preventDefault());
list.addEventListener("selectstart", (event) => event.preventDefault());
list.addEventListener("dragstart", (event) => event.preventDefault());
document.addEventListener("pointerdown", startUndoSwipe);
window.addEventListener("pointermove", moveUndoSwipe, { passive: false });
window.addEventListener("pointermove", handlePointerMove, { passive: false });
window.addEventListener("pointerup", endUndoSwipe);
window.addEventListener("pointercancel", (event) => endUndoSwipe(event, true));
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
