import { useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_PROGRESSION = "I@1, IV@1, V7@2";
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
    const deepestVisibleLayer = Math.max(0, visibleLayers.length - 1);
    const nodes = [];
    const edges = [];
    const brackets = [];
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
        x: width / 2,
        y: height / 2,
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
      layerData.progressionDisplay.forEach((token, tokenIndex) => {
        makeNode({ label: token, kind, layer: layerIndex, index: tokenIndex });
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

    let finalRowY = height / 2 + cfg.layerGap * 2;
    const projectedLeafIds = new Set();
    let finals = [];

    function updateLayout() {
      const leaves = nodes.filter((n) => n.layer === deepestVisibleLayer);
      const deepestLeafLayer = leaves.reduce((mx, n) => Math.max(mx, n.layer), 0);
      finalRowY = height / 2 + deepestLeafLayer * cfg.layerGap;
      finals = leaves
        .filter((n) => projectedLeafIds.has(n.id))
        .map((n) => ({ id: `f-${n.id}`, sourceId: n.id, label: n.label }));

      const y0 = height / 2;
      nodes.forEach((n) => {
        n.y = y0 + n.layer * cfg.layerGap;
      });
      const roots = (byLayer.get(0) || []).slice().sort((a, b) => a.index - b.index);

      function calcSize(node) {
        const box = labelBox(node.label, fontPx(node.kind));
        node.bw = box.width + cfg.subtreePadX * 2;
        node.bh = box.height + cfg.subtreePadY * 2;

        if (node.layer === deepestVisibleLayer || node.children.length === 0) {
          if (projectedLeafIds.has(node.id)) {
            const finalW = labelBox(node.label, clamp(width * 0.03, 22, 34)).width;
            node.sw = Math.max(node.bw, finalW + cfg.subtreePadX * 2);
          } else {
            node.sw = node.bw;
          }
          return;
        }

        let childrenWidth = 0;
        node.children.forEach((childId) => {
          const child = byId.get(childId);
          if (!child) return;
          calcSize(child);
          childrenWidth += child.sw;
        });
        childrenWidth += (Math.max(0, node.children.length - 1)) * cfg.collisionPadding;
        node.sw = Math.max(node.bw, childrenWidth);
      }

      let totalTreeW = 0;
      roots.forEach((root) => {
        calcSize(root);
        totalTreeW += root.sw;
      });
      totalTreeW += (Math.max(0, roots.length - 1)) * cfg.collisionPadding;
      let startX = width / 2 - totalTreeW / 2;

      function positionNode(node, x) {
        node.x = x;
        if (node.layer === deepestVisibleLayer || node.children.length === 0) return;
        const children = node.children.map((id) => byId.get(id)).filter(Boolean);
        let childTotal = children.reduce((acc, child) => acc + child.sw, 0);
        childTotal += Math.max(0, children.length - 1) * cfg.collisionPadding;
        let cx = x - childTotal / 2;
        children.forEach((child) => {
          positionNode(child, cx + child.sw / 2);
          cx += child.sw + cfg.collisionPadding;
        });
      }

      roots.forEach((root) => {
        positionNode(root, startX + root.sw / 2);
        startX += root.sw + cfg.collisionPadding;
      });

      function calcBounds(node) {
        let left = node.x - node.bw / 2;
        let right = node.x + node.bw / 2;
        let top = node.y - node.bh / 2;
        let bottom = node.y + node.bh / 2;

        if (node.layer === deepestVisibleLayer || node.children.length === 0) {
          if (projectedLeafIds.has(node.id)) {
            const finalBox = labelBox(node.label, clamp(width * 0.03, 22, 34));
            left = Math.min(left, node.x - finalBox.width / 2 - cfg.subtreePadX);
            right = Math.max(right, node.x + finalBox.width / 2 + cfg.subtreePadX);
            bottom = Math.max(bottom, finalRowY + finalBox.height / 2 + cfg.subtreePadY);
          }
        } else {
          node.children.forEach((childId) => {
            const child = byId.get(childId);
            if (!child) return;
            const cb = calcBounds(child);
            left = Math.min(left, cb.left);
            right = Math.max(right, cb.right);
            top = Math.min(top, cb.top, node.y + 12);
            bottom = Math.max(bottom, cb.bottom, node.y + 12);
          });
        }

        node.bounds = { left, right, top, bottom, width: right - left, height: bottom - top };
        return node.bounds;
      }

      roots.forEach((root) => calcBounds(root));
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

      finalLayer.selectAll("line.final-drop").data(finals, (d) => d.id).join("line")
        .attr("class", "final-drop")
        .attr("x1", (d) => byId.get(d.sourceId).x)
        .attr("y1", (d) => byId.get(d.sourceId).y + 16)
        .attr("x2", (d) => byId.get(d.sourceId).x)
        .attr("y2", finalRowY - 20);

      finalLayer.selectAll("text.final-chord").data(finals, (d) => d.id).join("text")
        .attr("class", "final-chord")
        .text((d) => d.label)
        .attr("x", (d) => byId.get(d.sourceId).x)
        .attr("y", finalRowY);

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
  const [durationUnit, setDurationUnit] = useState("beats");
  const [beatsPerBar, setBeatsPerBar] = useState("4");
  const [layers, setLayers] = useState([
    {
      id: "layer-0",
      progressionBeats: initialDisplay,
      progressionDisplay: initialDisplay,
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

  function requestPayload(progressionText) {
    return {
      progression: progressionText,
      durationUnit,
      beatsPerBar
    };
  }

  async function refreshSuggestions(displayTokens) {
    const progressionText = displayTokens.join(", ");
    const data = await postJSON("/api/suggest", requestPayload(progressionText));
    setSuggestions(data.suggestions || []);
    setSelectedSuggestionId("");
    setInfo(`Loaded ${data.suggestions.length} suggestion(s).`);
  }

  async function handleStart() {
    setBusy(true);
    setError("");
    setSuggestions([]);
    setSelectedSuggestionId("");

    try {
      const parseResponse = await postJSON("/api/parse", requestPayload(progressionInput));
      const root = {
        id: "layer-0",
        progressionBeats: parseResponse.progression.beats,
        progressionDisplay: parseResponse.progression.display,
        applied: null
      };
      setLayers([root]);
      await refreshSuggestions(root.progressionDisplay);
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
      await refreshSuggestions(currentLayer.progressionDisplay);
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
        applied: {
          rule: suggestion.rule,
          span: suggestion.span,
          replacementSpanInResult: suggestion.replacementSpanInResult
        }
      };
      const nextLayers = [...layers, nextLayer];
      setLayers(nextLayers);
      await refreshSuggestions(nextLayer.progressionDisplay);
      setProgressionInput(nextLayer.progressionDisplay.join(", "));
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

        <label className="field-label" htmlFor="progression-input">Progression input (@ durations)</label>
        <textarea
          id="progression-input"
          value={progressionInput}
          onChange={(event) => setProgressionInput(event.target.value)}
          rows={4}
          placeholder="I@1, IV@1, V7@2"
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
      </main>
    </div>
  );
}
