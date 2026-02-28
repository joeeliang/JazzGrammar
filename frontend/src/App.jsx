import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_PROGRESSION = "I@1, IV@1, V7@2";
const KEY_OPTIONS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const DEFAULT_CFG = {
  maxDepth: 6,
  layerGap: 110,
  subtreePadX: 10,
  subtreePadY: 10,
  labelPadX: 12,
  labelPadY: 8,
  collisionPadding: 12
};

const BOX_COLORS = [
  { stroke: "#1f77b4", fill: "rgba(31, 119, 180, 0.08)" },
  { stroke: "#2ca02c", fill: "rgba(44, 160, 44, 0.08)" },
  { stroke: "#d62728", fill: "rgba(214, 39, 40, 0.08)" },
  { stroke: "#ff7f0e", fill: "rgba(255, 127, 14, 0.08)" },
  { stroke: "#17becf", fill: "rgba(23, 190, 207, 0.08)" },
  { stroke: "#8c564b", fill: "rgba(140, 86, 75, 0.08)" },
  { stroke: "#7f7f7f", fill: "rgba(127, 127, 127, 0.08)" }
];

function tokenizeProgression(progression) {
  return progression.split(",").map((part) => part.trim()).filter(Boolean);
}

function chordLabel(token) {
  return token.split("@")[0].trim();
}

function durationInBeats(token) {
  const at = token.lastIndexOf("@");
  if (at < 0) return 1;
  const raw = token.slice(at + 1).trim();
  if (!raw) return 1;
  if (raw.includes("/")) {
    const [num, den] = raw.split("/");
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 1;
    return n / d;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function extractGridMarkers(gridText) {
  if (!gridText || typeof gridText !== "string") return [];
  const markers = [];
  const lines = gridText.split("\n").map((line) => line.trim()).filter(Boolean);
  let beatOffset = 0;

  lines.forEach((line) => {
    const match = line.match(/^\|\s*(.*?)\s*\|$/);
    if (!match) return;
    const beats = match[1].split("/").map((beat) => beat.trim());
    markers.push({ beat: beatOffset, symbol: "|" });
    beats.forEach((beatText, beatIndex) => {
      if (beatIndex > 0) {
        markers.push({ beat: beatOffset + beatIndex, symbol: "/" });
      }
      const parts = beatText.split(",").map((part) => part.trim()).filter(Boolean);
      const count = Math.max(1, parts.length);
      for (let subIndex = 1; subIndex < count; subIndex += 1) {
        markers.push({
          beat: beatOffset + beatIndex + (subIndex / count),
          symbol: ","
        });
      }
    });
    beatOffset += 4;
    markers.push({ beat: beatOffset, symbol: "|" });
  });

  const unique = new Map();
  markers.forEach((marker, index) => {
    const key = `${marker.symbol}@${marker.beat.toFixed(4)}`;
    if (!unique.has(key)) {
      unique.set(key, { ...marker, id: `${key}-${index}` });
    }
  });
  return Array.from(unique.values());
}

async function postJSON(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function buildChildParentMap(parentCount, childCount, applied) {
  if (!applied) {
    return Array.from({ length: childCount }, (_, childIndex) => Math.min(childIndex, parentCount - 1));
  }
  const [spanStart, spanEnd] = applied.span;
  const [repStart, repEnd] = applied.replacementSpanInResult;
  const oldCount = Math.max(1, spanEnd - spanStart);
  const newCount = Math.max(1, repEnd - repStart);
  const delta = newCount - oldCount;
  const map = [];

  for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
    let parentIndex;
    if (childIndex < repStart) {
      parentIndex = childIndex;
    } else if (childIndex >= repEnd) {
      parentIndex = childIndex - delta;
    } else if (newCount === 1 || oldCount === 1) {
      parentIndex = spanStart;
    } else {
      const ratio = (childIndex - repStart) / (newCount - 1);
      parentIndex = spanStart + Math.round(ratio * (oldCount - 1));
    }
    map.push(Math.max(0, Math.min(parentCount - 1, parentIndex)));
  }
  return map;
}

function D3ProgressionDiagram({ layers, cfg, showBoxes }) {
  const hostRef = useRef(null);
  const svgRef = useRef(null);
  const sceneRef = useRef(null);
  const transformRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({ width: Math.max(1, width), height: Math.max(1, height) });
      }
    });
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || size.width <= 0 || size.height <= 0) return undefined;
    const d3 = window.d3;
    if (!d3) return undefined;
    if (!transformRef.current) transformRef.current = d3.zoomIdentity;

    const svg = d3.select(svgRef.current)
      .attr("width", size.width)
      .attr("height", size.height);

    svg.selectAll("*").remove();
    const viewport = svg.append("g");
    const boxLayer = viewport.append("g");
    const edgeLayer = viewport.append("g");
    const nodeLayer = viewport.append("g");
    const finalLayer = viewport.append("g");
    const annotationLayer = viewport.append("g");

    const zoomBehavior = d3.zoom()
      .scaleExtent([0.15, 4.2])
      .filter((event) => {
        if (event.type === "wheel") return true;
        if (event.type === "dblclick") return false;
        if (event.type === "mousedown") return event.button === 0;
        return true;
      })
      .on("start", (event) => {
        if (event.sourceEvent && event.sourceEvent.type === "mousedown") {
          svg.classed("is-dragging", true);
        }
      })
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        viewport.attr("transform", event.transform);
      })
      .on("end", () => svg.classed("is-dragging", false));

    svg.call(zoomBehavior).on("dblclick.zoom", null);
    svg.call(zoomBehavior.transform, transformRef.current);
    svg.on("mousedown.cursor", (event) => {
      if (event.button === 0) svg.classed("is-dragging", true);
    });

    sceneRef.current = { svg, boxLayer, edgeLayer, nodeLayer, finalLayer, annotationLayer };
    return () => {
      svg.on(".zoom", null);
      svg.on("mousedown.cursor", null);
      sceneRef.current = null;
    };
  }, [size.width, size.height]);

  useEffect(() => {
    if (!sceneRef.current || layers.length === 0) return;

    const { svg, boxLayer, edgeLayer, nodeLayer, finalLayer, annotationLayer } = sceneRef.current;
    const width = size.width;
    const height = size.height;
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const fontPx = (kind) => (kind === "root" ? clamp(width * 0.04, 28, 54) : clamp(width * 0.03, 22, 36));
    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) return;

    const labelBox = (label, px) => {
      measureCtx.font = `${px}px "Latin Modern Roman", "CMU Serif", "Times New Roman", serif`;
      return {
        width: measureCtx.measureText(label).width + cfg.labelPadX * 2,
        height: px * 1.1 + cfg.labelPadY * 2
      };
    };

    const visibleLayerCount = Math.min(layers.length, cfg.maxDepth + 1);
    const visibleLayers = layers.slice(0, visibleLayerCount);
    const nodes = [];
    const edges = [];
    const brackets = [];
    const timeMarkers = [];
    const byId = new Map();
    const byLayer = new Map();

    function makeNode({ label, kind, layer, index }) {
      const node = {
        id: `n-${layer}-${index}`,
        label,
        kind,
        layer,
        index,
        parentId: null,
        children: [],
        durationBeats: 1,
        startBeat: 0,
        x: width / 2,
        y: 0,
        left: 0,
        right: 0,
        bw: 0,
        bh: 0,
        bounds: {}
      };
      nodes.push(node);
      byId.set(node.id, node);
      if (!byLayer.has(layer)) byLayer.set(layer, []);
      byLayer.get(layer).push(node);
      return node;
    }

    visibleLayers.forEach((layerData, layerIndex) => {
      const kind = layerIndex === 0 ? "root" : "tree";
      const labelTokens = layerData.progressionDisplay && layerData.progressionDisplay.length > 0
        ? layerData.progressionDisplay
        : layerData.progressionBeats;
      const durationTokens = layerData.progressionBeats && layerData.progressionBeats.length > 0
        ? layerData.progressionBeats
        : layerData.progressionDisplay;
      let cursor = 0;
      durationTokens.forEach((token, tokenIndex) => {
        const labelToken = labelTokens[tokenIndex] || token;
        const node = makeNode({
          label: chordLabel(labelToken),
          kind,
          layer: layerIndex,
          index: tokenIndex
        });
        node.durationBeats = durationInBeats(token);
        node.startBeat = cursor;
        cursor += node.durationBeats;
      });

      const layerMarkers = extractGridMarkers(layerData.progressionGridDisplay || layerData.progressionGrid);
      layerMarkers.forEach((marker) => {
        timeMarkers.push({
          id: `m-${layerIndex}-${marker.id}`,
          layer: layerIndex,
          beat: marker.beat,
          symbol: marker.symbol
        });
      });
    });

    for (let layerIndex = 1; layerIndex < visibleLayers.length; layerIndex += 1) {
      const parentLayer = byLayer.get(layerIndex - 1) || [];
      const childLayer = byLayer.get(layerIndex) || [];
      const parentCount = parentLayer.length;
      const childCount = childLayer.length;
      if (parentCount === 0 || childCount === 0) continue;
      const applied = visibleLayers[layerIndex].applied;
      const parentMap = buildChildParentMap(parentCount, childCount, applied);

      childLayer.forEach((childNode, childIndex) => {
        const parentIndex = parentMap[childIndex];
        const parentNode = parentLayer[parentIndex];
        if (!parentNode) return;
        childNode.parentId = parentNode.id;
        parentNode.children.push(childNode.id);
        let changed = false;
        if (applied) {
          const [repStart, repEnd] = applied.replacementSpanInResult;
          changed = childIndex >= repStart && childIndex < repEnd;
        }
        edges.push({
          id: `e-${parentNode.id}-${childNode.id}`,
          sourceId: parentNode.id,
          targetId: childNode.id,
          changed
        });
      });

      if (applied) {
        const [spanStart, spanEnd] = applied.span;
        const parentNodes = parentLayer.slice(spanStart, spanEnd);
        if (parentNodes.length > 0) {
          brackets.push({
            id: `b-${layerIndex}`,
            layer: layerIndex - 1,
            rule: applied.rule,
            spanStart,
            spanEnd
          });
        }
      }
    }

    function updateLayout() {
      const y0 = height / 2;
      const leftPad = clamp(width * 0.06, 45, 90);
      const rightPad = clamp(width * 0.06, 45, 90);

      const nodeEndBeats = nodes.map((node) => node.startBeat + node.durationBeats);
      const markerBeats = timeMarkers.map((marker) => marker.beat);
      const maxBeat = Math.max(1, ...nodeEndBeats, ...markerBeats);
      const pxPerBeat = (width - leftPad - rightPad) / maxBeat;

      nodes.forEach((node) => {
        const box = labelBox(node.label, fontPx(node.kind));
        node.y = y0 + node.layer * cfg.layerGap;
        node.left = leftPad + node.startBeat * pxPerBeat;
        node.right = leftPad + (node.startBeat + node.durationBeats) * pxPerBeat;
        node.bw = Math.max(8, node.right - node.left - 2);
        node.bh = box.height + cfg.subtreePadY * 2;
        node.x = (node.left + node.right) / 2;
        node.bounds = {
          left: node.x - node.bw / 2,
          right: node.x + node.bw / 2,
          top: node.y - node.bh / 2,
          bottom: node.y + node.bh / 2,
          width: node.bw,
          height: node.bh
        };
      });

      timeMarkers.forEach((marker) => {
        marker.x = leftPad + marker.beat * pxPerBeat;
        marker.y = y0 + marker.layer * cfg.layerGap - 34;
      });
    }

    function renderD3() {
      nodeLayer.selectAll("text.node").data(nodes, (d) => d.id).join("text")
        .attr("class", (d) => (d.kind === "root" ? "chord node" : "tree-chord node"))
        .text((d) => d.label)
        .attr("x", (d) => d.x)
        .attr("y", (d) => d.y);

      edgeLayer.selectAll("line.branch").data(edges, (d) => d.id).join("line")
        .attr("class", (d) => (d.changed ? "branch changed" : "branch"))
        .attr("x1", (d) => byId.get(d.sourceId).x)
        .attr("y1", (d) => byId.get(d.sourceId).y + 12)
        .attr("x2", (d) => byId.get(d.targetId).x)
        .attr("y2", (d) => byId.get(d.targetId).y - 18);

      boxLayer.selectAll("rect.subtree-box").data(nodes, (d) => d.id).join("rect")
        .attr("class", "subtree-box")
        .attr("stroke", (d) => BOX_COLORS[d.layer % BOX_COLORS.length].stroke)
        .attr("fill", (d) => BOX_COLORS[d.layer % BOX_COLORS.length].fill)
        .attr("x", (d) => d.bounds.left)
        .attr("y", (d) => d.bounds.top)
        .attr("width", (d) => d.bounds.width)
        .attr("height", (d) => d.bounds.height)
        .attr("opacity", showBoxes ? 1 : 0);

      finalLayer.selectAll("*").remove();

      const bracketData = brackets.map((bracket) => {
        const layerNodes = byLayer.get(bracket.layer) || [];
        const spanNodes = layerNodes.slice(bracket.spanStart, bracket.spanEnd);
        if (spanNodes.length === 0) return null;
        const leftNode = spanNodes[0];
        const rightNode = spanNodes[spanNodes.length - 1];
        const left = leftNode.x - leftNode.bw / 2;
        const right = rightNode.x + rightNode.bw / 2;
        const y = leftNode.y + 34;
        return {
          ...bracket,
          left,
          right,
          y
        };
      }).filter(Boolean);

      annotationLayer.selectAll("path.substitution-bracket").data(bracketData, (d) => d.id).join("path")
        .attr("class", "substitution-bracket")
        .attr("d", (d) => `M ${d.left} ${d.y} L ${d.left} ${d.y + 8} L ${d.right} ${d.y + 8} L ${d.right} ${d.y}`);

      annotationLayer.selectAll("text.substitution-label").data(bracketData, (d) => d.id).join("text")
        .attr("class", "substitution-label")
        .text((d) => `Rule ${d.rule}`)
        .attr("x", (d) => (d.left + d.right) / 2)
        .attr("y", (d) => d.y + 24);

      annotationLayer.selectAll("text.temporal-marker").data(timeMarkers, (d) => d.id).join("text")
        .attr("class", "substitution-label temporal-marker")
        .text((d) => d.symbol)
        .attr("x", (d) => d.x)
        .attr("y", (d) => d.y);
    }

    updateLayout();
    renderD3();
  }, [cfg, layers, showBoxes, size.height, size.width]);

  return (
    <div ref={hostRef} id="notes-display">
      <svg ref={svgRef} />
    </div>
  );
}

export default function App() {
  const initialDisplay = tokenizeProgression(DEFAULT_PROGRESSION);
  const [progressionInput, setProgressionInput] = useState(DEFAULT_PROGRESSION);
  const [notationMode, setNotationMode] = useState("duration");
  const [durationUnit, setDurationUnit] = useState("beats");
  const [beatsPerBar, setBeatsPerBar] = useState("4");
  const [displayMode, setDisplayMode] = useState("roman");
  const [displayKey, setDisplayKey] = useState("C");
  const [layers, setLayers] = useState([
    {
      id: "layer-0",
      progressionBeats: initialDisplay,
      progressionDisplay: initialDisplay,
      progressionGrid: "",
      progressionGridDisplay: "",
      applied: null
    }
  ]);
  const [suggestions, setSuggestions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("Default progression loaded. Click Start to fetch backend suggestions.");
  const [selectedSuggestionId, setSelectedSuggestionId] = useState("");
  const [showBoxes, setShowBoxes] = useState(true);
  const [cfg, setCfg] = useState(DEFAULT_CFG);

  const currentLayer = layers.length > 0 ? layers[layers.length - 1] : null;
  const suggestionCountLabel = useMemo(() => {
    if (suggestions.length === 1) return "1 suggestion";
    return `${suggestions.length} suggestions`;
  }, [suggestions.length]);

  function requestPayload(
    progressionText,
    mode = notationMode,
    nextDisplayMode = displayMode,
    nextDisplayKey = displayKey,
    nextInputDurationUnit = null
  ) {
    const payload = {
      progression: progressionText,
      notationMode: mode,
      durationUnit,
      beatsPerBar,
      displayMode: nextDisplayMode,
      displayKey: nextDisplayKey
    };
    if (nextInputDurationUnit) {
      payload.inputDurationUnit = nextInputDurationUnit;
    }
    return payload;
  }

  async function refreshSuggestions(
    progressionText,
    mode = notationMode,
    nextDisplayMode = displayMode,
    nextDisplayKey = displayKey,
    nextInputDurationUnit = "beats"
  ) {
    const data = await postJSON(
      "/api/suggest",
      requestPayload(
        progressionText,
        mode,
        nextDisplayMode,
        nextDisplayKey,
        nextInputDurationUnit
      )
    );
    setSuggestions(data.suggestions || []);
    setSelectedSuggestionId("");
    setInfo(`Loaded ${data.suggestions.length} suggestion(s).`);
  }

  async function rehydrateDisplay(nextDisplayMode, nextDisplayKey) {
    if (layers.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const refreshedLayers = [];
      for (const layer of layers) {
        const progressionText = layer.progressionBeats.join(", ");
        const parseResponse = await postJSON(
          "/api/parse",
          requestPayload(
            progressionText,
            "duration",
            nextDisplayMode,
            nextDisplayKey,
            "beats"
          )
        );
        refreshedLayers.push({
          ...layer,
          progressionDisplay: parseResponse.progression.display,
          progressionGrid: parseResponse.progression.grid,
          progressionGridDisplay: parseResponse.progression.gridDisplay || parseResponse.progression.grid
        });
      }
      setLayers(refreshedLayers);
      const active = refreshedLayers[refreshedLayers.length - 1];
      await refreshSuggestions(
        active.progressionBeats.join(", "),
        "duration",
        nextDisplayMode,
        nextDisplayKey
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisplayModeChange(nextMode) {
    setDisplayMode(nextMode);
    await rehydrateDisplay(nextMode, displayKey);
  }

  async function handleDisplayKeyChange(nextKey) {
    setDisplayKey(nextKey);
    if (displayMode === "roman") return;
    await rehydrateDisplay(displayMode, nextKey);
  }

  async function handleStart() {
    setBusy(true);
    setError("");
    setSuggestions([]);
    setSelectedSuggestionId("");

    try {
      const parseResponse = await postJSON("/api/parse", requestPayload(progressionInput, "auto"));
      const parsedMode = parseResponse.meta?.notationMode || notationMode;
      setNotationMode(parsedMode);
      const root = {
        id: "layer-0",
        progressionBeats: parseResponse.progression.beats,
        progressionDisplay: parseResponse.progression.display,
        progressionGrid: parseResponse.progression.grid,
        progressionGridDisplay: parseResponse.progression.gridDisplay || parseResponse.progression.grid,
        applied: null
      };
      setLayers([root]);
      await refreshSuggestions(root.progressionBeats.join(", "), "duration");
      if (parsedMode === "grid") {
        setProgressionInput(root.progressionGrid || progressionInput);
      } else {
        setProgressionInput(root.progressionBeats.join(", "));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshSuggestions() {
    if (!currentLayer) return;
    setBusy(true);
    setError("");
    try {
      await refreshSuggestions(currentLayer.progressionBeats.join(", "), "duration");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApplySuggestion(suggestion) {
    if (!currentLayer) return;
    setBusy(true);
    setError("");
    try {
      const nextLayer = {
        id: `layer-${layers.length}`,
        progressionBeats: suggestion.result.beats,
        progressionDisplay: suggestion.result.display,
        progressionGrid: suggestion.result.grid,
        progressionGridDisplay: suggestion.result.gridDisplay || suggestion.result.grid,
        applied: {
          rule: suggestion.rule,
          span: suggestion.span,
          replacementSpanInResult: suggestion.replacementSpanInResult
        }
      };
      const nextLayers = [...layers, nextLayer];
      setLayers(nextLayers);
      await refreshSuggestions(nextLayer.progressionBeats.join(", "), "duration");
      if (notationMode === "grid") {
        setProgressionInput(nextLayer.progressionGrid || progressionInput);
      } else {
        setProgressionInput(nextLayer.progressionBeats.join(", "));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function updateCfg(key, value) {
    setCfg((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="app-shell">
      <aside className="left-panel ui-panel">
        <h1>Jazz Grammar Explorer</h1>
        <p className="subtitle">Rule-driven suggestions from backend grammar rewrites.</p>

        <label className="field-label" htmlFor="progression-input">Progression input (@ durations or chord grid)</label>
        <textarea
          id="progression-input"
          value={progressionInput}
          onChange={(event) => setProgressionInput(event.target.value)}
          rows={4}
          placeholder={"I@1, IV@1, V7@2\nor\n| I / I,ii / ii / ii |"}
        />

        <div className="row">
          <label className="field-label" htmlFor="duration-unit">Unit</label>
          <select
            id="duration-unit"
            value={durationUnit}
            onChange={(event) => setDurationUnit(event.target.value)}
          >
            <option value="beats">Beats</option>
            <option value="bars">Bars</option>
          </select>
        </div>

        <div className="row">
          <label className="field-label" htmlFor="beats-per-bar">Beats per bar</label>
          <input
            id="beats-per-bar"
            type="number"
            min="1"
            step="0.5"
            value={beatsPerBar}
            onChange={(event) => setBeatsPerBar(event.target.value)}
          />
        </div>

        <div className="row">
          <label className="field-label" htmlFor="display-mode">Display</label>
          <select
            id="display-mode"
            value={displayMode}
            onChange={(event) => handleDisplayModeChange(event.target.value)}
          >
            <option value="roman">Roman numerals</option>
            <option value="key">Realized key</option>
          </select>
        </div>

        <div className="row">
          <label className="field-label" htmlFor="display-key">Key</label>
          <select
            id="display-key"
            value={displayKey}
            onChange={(event) => handleDisplayKeyChange(event.target.value)}
            disabled={busy || displayMode === "roman"}
          >
            {KEY_OPTIONS.map((keyName) => (
              <option key={keyName} value={keyName}>{keyName}</option>
            ))}
          </select>
        </div>

        <div className="button-row">
          <button type="button" onClick={handleStart} disabled={busy}>Start</button>
          <button type="button" onClick={handleRefreshSuggestions} disabled={busy || !currentLayer}>Refresh</button>
        </div>

        {error ? <p className="status error">{error}</p> : <p className="status">{info}</p>}

        <div className="suggestions-head">
          <strong>Options</strong>
          <span>{suggestionCountLabel}</span>
        </div>
        <div className="suggestions-list">
          {suggestions.length === 0 ? (
            <div className="empty">No suggestions yet.</div>
          ) : (
            suggestions.map((suggestion) => {
              const isSelected = selectedSuggestionId === suggestion.id;
              return (
                <button
                  className={isSelected ? "suggestion is-selected" : "suggestion"}
                  key={suggestion.id}
                  type="button"
                  onClick={() => {
                    setSelectedSuggestionId(suggestion.id);
                    handleApplySuggestion(suggestion);
                  }}
                  disabled={busy}
                >
                  <span className="suggestion-title">{suggestion.summary}</span>
                  <span className="suggestion-body">
                    {suggestion.before.display.join(" | ")} {"->"} {suggestion.result.display.join(" | ")}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <main className="canvas-shell">
        <D3ProgressionDiagram layers={layers} cfg={cfg} showBoxes={showBoxes} />

        <aside id="controls" className="ui-panel" aria-label="Layout controls">
          <h2>Tuning</h2>
          <div className="toggle-row">
            <input
              id="toggle-boxes"
              type="checkbox"
              checked={showBoxes}
              onChange={(event) => setShowBoxes(event.target.checked)}
            />
            <label htmlFor="toggle-boxes">Show bounding boxes</label>
          </div>

          <div className="slider-row">
            <label htmlFor="max-depth">Max depth</label>
            <span id="max-depth-value" className="slider-value">{cfg.maxDepth}</span>
            <input
              id="max-depth"
              type="range"
              min="1"
              max="10"
              step="1"
              value={cfg.maxDepth}
              onChange={(event) => updateCfg("maxDepth", Number(event.target.value))}
            />
          </div>

          <div className="slider-row">
            <label htmlFor="layer-gap">Layer gap</label>
            <span id="layer-gap-value" className="slider-value">{cfg.layerGap}px</span>
            <input
              id="layer-gap"
              type="range"
              min="50"
              max="240"
              step="1"
              value={cfg.layerGap}
              onChange={(event) => updateCfg("layerGap", Number(event.target.value))}
            />
          </div>

          <div className="slider-row">
            <label htmlFor="collision-padding">Sibling gap</label>
            <span id="collision-padding-value" className="slider-value">{cfg.collisionPadding}px</span>
            <input
              id="collision-padding"
              type="range"
              min="0"
              max="90"
              step="1"
              value={cfg.collisionPadding}
              onChange={(event) => updateCfg("collisionPadding", Number(event.target.value))}
            />
          </div>

          <div className="slider-row">
            <label htmlFor="subtree-pad-x">Box pad X</label>
            <span id="subtree-pad-x-value" className="slider-value">{cfg.subtreePadX}px</span>
            <input
              id="subtree-pad-x"
              type="range"
              min="0"
              max="70"
              step="1"
              value={cfg.subtreePadX}
              onChange={(event) => updateCfg("subtreePadX", Number(event.target.value))}
            />
          </div>

          <div className="slider-row">
            <label htmlFor="subtree-pad-y">Box pad Y</label>
            <span id="subtree-pad-y-value" className="slider-value">{cfg.subtreePadY}px</span>
            <input
              id="subtree-pad-y"
              type="range"
              min="0"
              max="70"
              step="1"
              value={cfg.subtreePadY}
              onChange={(event) => updateCfg("subtreePadY", Number(event.target.value))}
            />
          </div>

          <div className="slider-row">
            <label htmlFor="label-pad-x">Text pad X</label>
            <span id="label-pad-x-value" className="slider-value">{cfg.labelPadX}px</span>
            <input
              id="label-pad-x"
              type="range"
              min="0"
              max="60"
              step="1"
              value={cfg.labelPadX}
              onChange={(event) => updateCfg("labelPadX", Number(event.target.value))}
            />
          </div>

          <div className="slider-row">
            <label htmlFor="label-pad-y">Text pad Y</label>
            <span id="label-pad-y-value" className="slider-value">{cfg.labelPadY}px</span>
            <input
              id="label-pad-y"
              type="range"
              min="0"
              max="60"
              step="1"
              value={cfg.labelPadY}
              onChange={(event) => updateCfg("labelPadY", Number(event.target.value))}
            />
          </div>
        </aside>

        <aside id="grid-output" className="ui-panel" aria-label="Generated chord grid output">
          <h2>Generated Chord Grid</h2>
          <pre>{currentLayer?.progressionGridDisplay || "Run Start to render grid notation."}</pre>
        </aside>
      </main>
    </div>
  );
}
