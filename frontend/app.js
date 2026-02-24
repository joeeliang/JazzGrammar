const ROOTS = ["I", "II", "III", "IV", "V", "VI", "VII"];
const QUALITIES = ["", "m", "7", "m7", "°7"];

const state = {
  progression: [],
};
let chordIdCounter = 0;

const paletteEl = document.getElementById("palette");
const dropZoneEl = document.getElementById("dropZone");
const progressionListEl = document.getElementById("progressionList");
const dropHelpEl = document.getElementById("dropHelp");
const clearBtn = document.getElementById("clearBtn");
const customChordForm = document.getElementById("customChordForm");
const customChordInput = document.getElementById("customChord");
const requestForm = document.getElementById("requestForm");
const endpointInput = document.getElementById("endpoint");
const depthInput = document.getElementById("depth");
const packetPreviewEl = document.getElementById("packetPreview");
const responsePreviewEl = document.getElementById("responsePreview");

function createPalette() {
  const tokens = [];
  ROOTS.forEach((root) => {
    QUALITIES.forEach((quality) => {
      tokens.push(`${root}${quality}`);
    });
  });

  tokens.forEach((token) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = token;
    chip.draggable = true;
    chip.dataset.chord = token;

    chip.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/chord-token", token);
      event.dataTransfer.effectAllowed = "copy";
    });

    chip.addEventListener("click", () => addChord(token));
    paletteEl.appendChild(chip);
  });
}

function addChord(chord, duration = "1") {
  state.progression.push({
    id: `chord-${chordIdCounter++}`,
    chord: chord.trim(),
    duration: normalizeDuration(duration),
  });
  renderProgression();
}

function removeChord(id) {
  state.progression = state.progression.filter((item) => item.id !== id);
  renderProgression();
}

function moveChord(id, direction) {
  const index = state.progression.findIndex((item) => item.id === id);
  if (index < 0) return;
  const target = index + direction;
  if (target < 0 || target >= state.progression.length) return;
  const copy = [...state.progression];
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item);
  state.progression = copy;
  renderProgression();
}

function updateDuration(id, duration) {
  const item = state.progression.find((entry) => entry.id === id);
  if (!item) return;
  item.duration = normalizeDuration(duration);
  renderPreviews();
}

function normalizeDuration(raw) {
  const value = String(raw || "").trim();
  return value || "1";
}

function toTimedToken(item) {
  if (item.duration === "1") return item.chord;
  return `${item.chord}@${item.duration}`;
}

function buildPayload() {
  const progression = state.progression.map((item) => ({
    chord: item.chord,
    duration: item.duration,
  }));
  const progression_tokens = state.progression.map((item) => toTimedToken(item));
  const payload = {
    progression,
    progression_tokens,
    progression_csv: progression_tokens.join(","),
  };

  const depthText = depthInput.value.trim();
  if (depthText !== "") {
    const parsedDepth = Number(depthText);
    if (Number.isInteger(parsedDepth) && parsedDepth >= 0) {
      payload.depth = parsedDepth;
    }
  }
  return payload;
}

function renderProgression() {
  progressionListEl.innerHTML = "";
  dropHelpEl.style.display = state.progression.length ? "none" : "block";

  state.progression.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "prog-item";

    const label = document.createElement("span");
    label.className = "prog-label";
    label.textContent = `${index + 1}. ${item.chord}`;

    const durationInput = document.createElement("input");
    durationInput.className = "duration-input";
    durationInput.type = "text";
    durationInput.value = item.duration;
    durationInput.title = "Duration (e.g. 1, 2, 3/2)";
    durationInput.addEventListener("change", () => {
      updateDuration(item.id, durationInput.value);
    });

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "compact";
    upBtn.textContent = "Up";
    upBtn.addEventListener("click", () => moveChord(item.id, -1));

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "compact";
    downBtn.textContent = "Down";
    downBtn.addEventListener("click", () => moveChord(item.id, 1));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "compact";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeChord(item.id));

    li.append(label, durationInput, upBtn, downBtn, removeBtn);
    progressionListEl.appendChild(li);
  });

  renderPreviews();
}

function renderPreviews() {
  const payload = buildPayload();
  packetPreviewEl.textContent = JSON.stringify(payload, null, 2);
}

function setupDropZone() {
  const setActive = (active) => {
    dropZoneEl.classList.toggle("active", active);
  };

  dropZoneEl.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setActive(true);
  });

  dropZoneEl.addEventListener("dragenter", () => setActive(true));
  dropZoneEl.addEventListener("dragleave", () => setActive(false));
  dropZoneEl.addEventListener("drop", (event) => {
    event.preventDefault();
    setActive(false);
    const token = event.dataTransfer.getData("text/chord-token");
    if (token) addChord(token);
  });
}

function validateBeforeSend() {
  if (!state.progression.length) {
    responsePreviewEl.textContent = "Add at least one chord before sending.";
    return false;
  }
  if (!endpointInput.value.trim()) {
    responsePreviewEl.textContent = "Backend endpoint is required.";
    return false;
  }
  return true;
}

async function sendPayload() {
  if (!validateBeforeSend()) return;

  const payload = buildPayload();
  const endpoint = endpointInput.value.trim();
  responsePreviewEl.textContent = "Sending...";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const contentType = res.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await res.json()
      : await res.text();

    responsePreviewEl.textContent = JSON.stringify(
      {
        ok: res.ok,
        status: res.status,
        body,
      },
      null,
      2,
    );
  } catch (error) {
    responsePreviewEl.textContent = JSON.stringify(
      {
        ok: false,
        error: String(error),
      },
      null,
      2,
    );
  }
}

clearBtn.addEventListener("click", () => {
  state.progression = [];
  renderProgression();
  responsePreviewEl.textContent = "";
});

customChordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = customChordInput.value.trim();
  if (!token) return;
  addChord(token);
  customChordInput.value = "";
});

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendPayload();
});

createPalette();
setupDropZone();
renderProgression();
