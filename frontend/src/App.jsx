import { useEffect, useMemo, useRef, useState } from "react";
import { JazzyChordEngine, defaultSynthParams } from "./audio/jazzyChordEngine";

const DEFAULT_PROGRESSION = "I@1, IV@1, V7@2";
const DEFAULT_ABSOLUTE_PROGRESSION = "Cmaj7@1, Dm7@1, G7@2";
const KEY_OPTIONS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").trim();
const DEFAULT_CFG = {
  maxDepth: 6,
  layerGap: 92,
  subtreePadX: 8,
  subtreePadY: 6,
  labelPadX: 10,
  labelPadY: 6,
  collisionPadding: 12
};
const SOUND_PARAM_CONFIG = [
  { key: "bpm", label: "BPM", min: 60, max: 180, step: 1 },
  { key: "strumMs", label: "Strum (ms)", min: 0, max: 100, step: 1 },
  { key: "attackMs", label: "Attack (ms)", min: 5, max: 220, step: 1 },
  { key: "releaseMs", label: "Release (ms)", min: 120, max: 1800, step: 10 },
  { key: "cutoffHz", label: "Cutoff (Hz)", min: 500, max: 6000, step: 10 },
  { key: "filterQ", label: "Filter Q", min: 0.2, max: 4, step: 0.1 },
  { key: "detuneCents", label: "Detune (cents)", min: 0, max: 24, step: 1 },
  { key: "harmonicMix", label: "Harmonic mix", min: 0, max: 1, step: 0.01 },
  { key: "masterVolume", label: "Master volume", min: 0.1, max: 1, step: 0.01 },
  { key: "voicePeak", label: "Voice peak", min: 0.08, max: 0.5, step: 0.01 },
  { key: "leadInMs", label: "Lead-in (ms)", min: 0, max: 250, step: 1 },
  { key: "endPadMs", label: "End pad (ms)", min: 40, max: 600, step: 5 }
];

const BOX_COLORS = [
  { stroke: "#6f7fff", fill: "rgba(99, 116, 255, 0.12)" },
  { stroke: "#4a76f4", fill: "rgba(74, 118, 244, 0.1)" },
  { stroke: "#2f8ac8", fill: "rgba(47, 138, 200, 0.1)" },
  { stroke: "#67a0f8", fill: "rgba(103, 160, 248, 0.1)" }
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

function clampParam(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

async function postJSON(path, payload) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = API_BASE_URL
    ? `${API_BASE_URL.replace(/\/+$/, "")}${normalizedPath}`
    : normalizedPath;
  const response = await fetch(url, {
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

function D3ProgressionDiagram({
  layers,
  cfg,
  selectedChord,
  onSelectChord,
  centerSignal,
  onPlayLayer,
  canPlayLayer,
  playingLayerIndex
}) {
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
    const annotationLayer = viewport.append("g");
    const playLayer = viewport.append("g");

    const zoomBehavior = d3.zoom()
      .scaleExtent([0.2, 4.2])
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

    sceneRef.current = {
      svg,
      boxLayer,
      edgeLayer,
      nodeLayer,
      annotationLayer,
      playLayer,
      zoomBehavior,
      contentBounds: null
    };

    return () => {
      svg.on(".zoom", null);
      svg.on("mousedown.cursor", null);
      sceneRef.current = null;
    };
  }, [size.width, size.height]);

  useEffect(() => {
    if (!sceneRef.current || layers.length === 0) return;

    const {
      boxLayer,
      edgeLayer,
      nodeLayer,
      annotationLayer,
      playLayer
    } = sceneRef.current;

    const width = size.width;
    const height = size.height;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const fontPx = (kind) => (kind === "root" ? clamp(width * 0.018, 13, 24) : clamp(width * 0.015, 12, 18));
    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) return;

    const labelBox = (label, px) => {
      measureCtx.font = `${px}px Inter, system-ui, -apple-system, sans-serif`;
      return {
        width: measureCtx.measureText(label).width + cfg.labelPadX * 2,
        height: px * 1.2 + cfg.labelPadY * 2
      };
    };

    const visibleLayerCount = Math.min(layers.length, cfg.maxDepth + 1);
    const visibleLayers = layers.slice(0, visibleLayerCount);
    const activeLayerIndex = Math.max(0, visibleLayers.length - 1);

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
            ruleName: applied.ruleName || applied.rule,
            spanStart,
            spanEnd
          });
        }
      }
    }

    const y0 = height / 2;
    const leftPad = clamp(width * 0.07, 48, 96);
    const rightPad = clamp(width * 0.07, 48, 96);

    const nodeEndBeats = nodes.map((node) => node.startBeat + node.durationBeats);
    const maxBeat = Math.max(1, ...nodeEndBeats);
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

    nodeLayer.selectAll("text.node").data(nodes, (d) => d.id).join("text")
      .attr("class", (d) => (d.kind === "root" ? "chord node" : "tree-chord node"))
      .text((d) => d.label)
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y);

    edgeLayer.selectAll("line.branch").data(edges, (d) => d.id).join("line")
      .attr("class", (d) => (d.changed ? "branch changed" : "branch"))
      .attr("x1", (d) => byId.get(d.sourceId).x)
      .attr("y1", (d) => byId.get(d.sourceId).y + 10)
      .attr("x2", (d) => byId.get(d.targetId).x)
      .attr("y2", (d) => byId.get(d.targetId).y - 15);

    boxLayer.selectAll("rect.subtree-box").data(nodes, (d) => d.id).join("rect")
      .attr("class", (d) => {
        const isSelected = selectedChord
          && selectedChord.layer === d.layer
          && selectedChord.index === d.index;
        const clickable = d.layer === activeLayerIndex;
        return `subtree-box${clickable ? " is-clickable" : ""}${isSelected ? " is-active-selection" : ""}`;
      })
      .attr("stroke", (d) => BOX_COLORS[d.layer % BOX_COLORS.length].stroke)
      .attr("fill", (d) => BOX_COLORS[d.layer % BOX_COLORS.length].fill)
      .attr("x", (d) => d.bounds.left)
      .attr("y", (d) => d.bounds.top)
      .attr("width", (d) => d.bounds.width)
      .attr("height", (d) => d.bounds.height)
      .attr("opacity", (d) => {
        if (selectedChord && selectedChord.layer === d.layer && selectedChord.index === d.index) return 0.94;
        return d.layer === activeLayerIndex ? 0.58 : 0.18;
      })
      .on("click", (event, d) => {
        if (d.layer !== activeLayerIndex || !onSelectChord) return;
        event.stopPropagation();
        onSelectChord({ layer: d.layer, index: d.index });
      });

    const bracketData = brackets.map((bracket) => {
      const layerNodes = byLayer.get(bracket.layer) || [];
      const spanNodes = layerNodes.slice(bracket.spanStart, bracket.spanEnd);
      if (spanNodes.length === 0) return null;
      const leftNode = spanNodes[0];
      const rightNode = spanNodes[spanNodes.length - 1];
      const left = leftNode.x - leftNode.bw / 2;
      const right = rightNode.x + rightNode.bw / 2;
      const y = leftNode.y + 30;
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
      .text((d) => d.ruleName)
      .attr("x", (d) => (d.left + d.right) / 2)
      .attr("y", (d) => d.y + 23);

    const controlData = visibleLayers.map((layerData, layerIndex) => {
      const layerNodes = byLayer.get(layerIndex) || [];
      const rowNode = layerNodes[0];
      return {
        id: `row-play-${layerIndex}`,
        layer: layerIndex,
        y: rowNode ? rowNode.y : (y0 + layerIndex * cfg.layerGap),
        x: leftPad - 46,
        canPlay: typeof canPlayLayer === "function" ? canPlayLayer(layerData) : false,
        isPlaying: playingLayerIndex === layerIndex
      };
    });

    const playGroups = playLayer.selectAll("g.row-play-control")
      .data(controlData, (d) => d.id)
      .join("g")
      .attr("class", (d) => {
        if (d.canPlay && d.isPlaying) return "row-play-control is-playing";
        if (d.canPlay) return "row-play-control";
        return "row-play-control is-disabled";
      })
      .attr("transform", (d) => `translate(${d.x}, ${d.y - 12})`)
      .style("pointer-events", "auto")
      .on("click", (event, d) => {
        event.stopPropagation();
        if (!d.canPlay || !onPlayLayer) return;
        onPlayLayer(d.layer);
      });

    playGroups.selectAll("rect").data((d) => [d]).join("rect")
      .attr("width", 42)
      .attr("height", 24)
      .attr("rx", 6)
      .attr("ry", 6);

    playGroups.selectAll("text").data((d) => [d]).join("text")
      .attr("x", 21)
      .attr("y", 12)
      .attr("dy", "0.34em")
      .text((d) => (d.isPlaying ? "Stop" : "Play"));

    if (nodes.length > 0) {
      sceneRef.current.contentBounds = {
        left: Math.min(...nodes.map((node) => node.bounds.left)),
        right: Math.max(...nodes.map((node) => node.bounds.right)),
        top: Math.min(...nodes.map((node) => node.bounds.top)),
        bottom: Math.max(...nodes.map((node) => node.bounds.bottom))
      };
    }
  }, [
    canPlayLayer,
    cfg,
    layers,
    onPlayLayer,
    onSelectChord,
    playingLayerIndex,
    selectedChord,
    size.height,
    size.width
  ]);

  useEffect(() => {
    if (!sceneRef.current?.contentBounds || size.width <= 0 || size.height <= 0) return;
    const d3 = window.d3;
    if (!d3) return;

    const { svg, zoomBehavior, contentBounds } = sceneRef.current;

    const pad = 52;
    const contentWidth = Math.max(1, contentBounds.right - contentBounds.left);
    const contentHeight = Math.max(1, contentBounds.bottom - contentBounds.top);

    const scale = Math.min(
      1.35,
      Math.max(
        0.28,
        Math.min(
          (size.width - pad * 2) / contentWidth,
          (size.height - pad * 2) / contentHeight
        )
      )
    );

    const tx = (size.width - contentWidth * scale) / 2 - contentBounds.left * scale;
    const ty = (size.height - contentHeight * scale) / 2 - contentBounds.top * scale;
    const target = d3.zoomIdentity.translate(tx, ty).scale(scale);

    transformRef.current = target;
    svg.transition().duration(260).call(zoomBehavior.transform, target);
  }, [centerSignal, layers.length, size.height, size.width]);

  return (
    <div ref={hostRef} className="notes-display" onClick={() => onSelectChord(null)}>
      <svg ref={svgRef} />
    </div>
  );
}

export default function App() {
  const initialDisplay = tokenizeProgression(DEFAULT_PROGRESSION);

  const [progressionInput, setProgressionInput] = useState(DEFAULT_PROGRESSION);
  const [notationMode, setNotationMode] = useState("duration");
  const [inputMode, setInputMode] = useState("roman");
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
      progressionEvents: [],
      applied: null
    }
  ]);

  const [suggestions, setSuggestions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("Default progression loaded. Click Start to fetch backend suggestions.");
  const [selectedSuggestionId, setSelectedSuggestionId] = useState("");
  const [selectedChord, setSelectedChord] = useState(null);
  const [playingLayerIndex, setPlayingLayerIndex] = useState(null);
  const [soundParams, setSoundParams] = useState({ ...defaultSynthParams });
  const synthRef = useRef(null);
  const playbackTimerRef = useRef(null);

  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(true);
  const [isSoundPanelOpen, setIsSoundPanelOpen] = useState(false);
  const [centerSignal, setCenterSignal] = useState(0);

  const currentLayer = layers.length > 0 ? layers[layers.length - 1] : null;
  const currentLayerIndex = Math.max(0, layers.length - 1);

  const filteredSuggestions = useMemo(() => {
    if (!selectedChord || selectedChord.layer !== currentLayerIndex) {
      return suggestions;
    }
    return suggestions.filter((suggestion) => (
      selectedChord.index >= suggestion.span[0] && selectedChord.index < suggestion.span[1]
    ));
  }, [currentLayerIndex, selectedChord, suggestions]);

  const suggestionCountLabel = useMemo(() => {
    const count = filteredSuggestions.length;
    if (selectedChord && selectedChord.layer === currentLayerIndex) {
      return `${count} of ${suggestions.length} suggestions`;
    }
    if (count === 1) return "1 suggestion";
    return `${count} suggestions`;
  }, [currentLayerIndex, filteredSuggestions.length, selectedChord, suggestions.length]);

  const selectedChordLabel = useMemo(() => {
    if (!selectedChord || selectedChord.layer !== currentLayerIndex || !currentLayer) {
      return "All chords";
    }
    const token = currentLayer.progressionDisplay[selectedChord.index]
      || currentLayer.progressionBeats[selectedChord.index]
      || "";
    return chordLabel(token) || `Chord ${selectedChord.index + 1}`;
  }, [currentLayer, currentLayerIndex, selectedChord]);

  useEffect(() => {
    setSelectedChord(null);
  }, [currentLayerIndex]);

  useEffect(() => {
    setCenterSignal((prev) => prev + 1);
  }, [layers.length]);

  useEffect(() => {
    if (!isSuggestionsOpen) return;
    setCenterSignal((prev) => prev + 1);
  }, [isSuggestionsOpen]);

  useEffect(() => () => {
    if (playbackTimerRef.current) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    if (synthRef.current) {
      synthRef.current.stop();
    }
  }, []);

  function handleSelectChord(nextSelection) {
    if (!nextSelection) {
      setSelectedChord(null);
      return;
    }
    setSelectedChord((prev) => {
      if (prev && prev.layer === nextSelection.layer && prev.index === nextSelection.index) {
        return null;
      }
      return nextSelection;
    });
  }

  function handleSoundParamChange(paramKey, rawValue) {
    const config = SOUND_PARAM_CONFIG.find((item) => item.key === paramKey);
    if (!config) return;
    setSoundParams((prev) => {
      const nextValue = clampParam(rawValue, config.min, config.max, prev[paramKey]);
      const nextParams = { ...prev, [paramKey]: nextValue };
      if (synthRef.current) {
        synthRef.current.setParams(nextParams);
      }
      return nextParams;
    });
  }

  function handleResetSoundParams() {
    const nextParams = { ...defaultSynthParams };
    setSoundParams(nextParams);
    if (synthRef.current) {
      synthRef.current.setParams(nextParams);
    }
  }

  function canPlayLayer(layerData) {
    if (!layerData || !Array.isArray(layerData.progressionEvents)) return false;
    return layerData.progressionEvents.some((event) => (
      Number(event?.bars) > 0
      && Array.isArray(event?.notes)
      && event.notes.length > 0
    ));
  }

  async function handlePlayLayer(layerIndex) {
    const layerData = layers[layerIndex];
    if (!canPlayLayer(layerData)) {
      return;
    }
    if (!synthRef.current) {
      synthRef.current = new JazzyChordEngine();
    }
    const synth = synthRef.current;

    if (playbackTimerRef.current) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }

    if (synth.isPlaying() && playingLayerIndex === layerIndex) {
      synth.stop();
      setPlayingLayerIndex(null);
      return;
    }

    if (synth.isPlaying()) {
      synth.stop();
    }

    try {
      setError("");
      setPlayingLayerIndex(layerIndex);
      const result = await synth.play(layerData.progressionEvents, soundParams);
      const durationMs = Math.max(120, Math.ceil((result?.durationSec || 0) * 1000) + 140);
      playbackTimerRef.current = window.setTimeout(() => {
        setPlayingLayerIndex(null);
        playbackTimerRef.current = null;
      }, durationMs);
    } catch (err) {
      setPlayingLayerIndex(null);
      setError(err?.message || "Unable to play progression.");
    }
  }

  function requestPayload(
    progressionText,
    mode = notationMode,
    nextDisplayMode = displayMode,
    nextDisplayKey = displayKey,
    nextInputDurationUnit = null,
    nextInputMode = inputMode
  ) {
    const payload = {
      progression: progressionText,
      notationMode: mode,
      inputMode: nextInputMode,
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
    nextInputDurationUnit = "beats",
    nextInputMode = "roman"
  ) {
    const data = await postJSON(
      "/api/suggest",
      requestPayload(
        progressionText,
        mode,
        nextDisplayMode,
        nextDisplayKey,
        nextInputDurationUnit,
        nextInputMode
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
            "beats",
            "roman"
          )
        );
        refreshedLayers.push({
          ...layer,
          progressionDisplay: parseResponse.progression.display,
          progressionGrid: parseResponse.progression.grid,
          progressionGridDisplay: parseResponse.progression.gridDisplay || parseResponse.progression.grid,
          progressionEvents: parseResponse.progression.events || []
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

  function handleInputModeChange(nextMode) {
    setInputMode(nextMode);
    if (nextMode === "absolute" && progressionInput.trim() === DEFAULT_PROGRESSION) {
      setProgressionInput(DEFAULT_ABSOLUTE_PROGRESSION);
    }
  }

  async function handleDisplayKeyChange(nextKey) {
    setDisplayKey(nextKey);
    if (displayMode === "roman" && inputMode !== "absolute") return;
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
      setInputMode(parseResponse.meta?.inputMode || inputMode);

      const root = {
        id: "layer-0",
        progressionBeats: parseResponse.progression.beats,
        progressionDisplay: parseResponse.progression.display,
        progressionGrid: parseResponse.progression.grid,
        progressionGridDisplay: parseResponse.progression.gridDisplay || parseResponse.progression.grid,
        progressionEvents: parseResponse.progression.events || [],
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
        progressionEvents: suggestion.result.events || [],
        applied: {
          rule: suggestion.rule,
          ruleName: suggestion.ruleName || suggestion.rule,
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Jazz Grammar Explorer</div>

        <div className="top-controls">
          <label className="top-field top-field-progression" htmlFor="progression-input">
            <span>Progression:</span>
            <input
              id="progression-input"
              value={progressionInput}
              onChange={(event) => setProgressionInput(event.target.value)}
              placeholder={inputMode === "absolute" ? "Cmaj7@1, Dm7@1, G7@2" : "I@1, IV@1, V7@2"}
            />
          </label>

          <label className="top-field" htmlFor="input-mode">
            <span>Input:</span>
            <select
              id="input-mode"
              value={inputMode}
              onChange={(event) => handleInputModeChange(event.target.value)}
            >
              <option value="roman">Roman numerals</option>
              <option value="absolute">Absolute chords</option>
            </select>
          </label>

          <label className="top-field" htmlFor="display-key">
            <span>Key:</span>
            <select
              id="display-key"
              value={displayKey}
              onChange={(event) => handleDisplayKeyChange(event.target.value)}
              disabled={busy}
            >
              {KEY_OPTIONS.map((keyName) => (
                <option key={keyName} value={keyName}>{keyName}</option>
              ))}
            </select>
          </label>

          <label className="top-field" htmlFor="beats-per-bar">
            <span>Beats:</span>
            <input
              id="beats-per-bar"
              type="number"
              min="1"
              step="0.5"
              value={beatsPerBar}
              onChange={(event) => setBeatsPerBar(event.target.value)}
            />
          </label>

          <label className="top-field" htmlFor="display-mode">
            <span>Display:</span>
            <select
              id="display-mode"
              value={displayMode}
              onChange={(event) => handleDisplayModeChange(event.target.value)}
            >
              <option value="roman">Roman numerals</option>
              <option value="key">Realized key</option>
            </select>
          </label>

          <label className="top-field" htmlFor="duration-unit">
            <span>Unit:</span>
            <select
              id="duration-unit"
              value={durationUnit}
              onChange={(event) => setDurationUnit(event.target.value)}
            >
              <option value="beats">Beats</option>
              <option value="bars">Bars</option>
            </select>
          </label>
        </div>

        <div className="top-actions">
          <button type="button" className="btn-primary" onClick={handleStart} disabled={busy}>Start</button>
          <button type="button" className="btn-secondary" onClick={handleRefreshSuggestions} disabled={busy || !currentLayer}>Refresh</button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setIsSoundPanelOpen((prev) => !prev)}
          >
            {isSoundPanelOpen ? "Hide" : "Show"} sound
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setIsSuggestionsOpen((prev) => !prev)}
          >
            {isSuggestionsOpen ? "Hide" : "Show"} suggestions
          </button>
        </div>
      </header>

      {isSoundPanelOpen && (
        <section className="sound-panel" aria-label="Sound controls">
          <div className="sound-panel-header">
            <h3>Sound Parameters</h3>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleResetSoundParams}
            >
              Reset
            </button>
          </div>
          <div className="sound-grid">
            {SOUND_PARAM_CONFIG.map((config) => (
              <label className="sound-control" key={config.key} htmlFor={`sound-${config.key}`}>
                <span>{config.label}</span>
                <input
                  id={`sound-${config.key}`}
                  type="range"
                  min={config.min}
                  max={config.max}
                  step={config.step}
                  value={soundParams[config.key]}
                  onChange={(event) => handleSoundParamChange(config.key, event.target.value)}
                />
                <input
                  type="number"
                  min={config.min}
                  max={config.max}
                  step={config.step}
                  value={soundParams[config.key]}
                  onChange={(event) => handleSoundParamChange(config.key, event.target.value)}
                />
              </label>
            ))}
          </div>
        </section>
      )}

      <div className="workspace">
        <main className="canvas-shell" aria-label="Chord progression tree view">
          <D3ProgressionDiagram
            layers={layers}
            cfg={DEFAULT_CFG}
            selectedChord={selectedChord}
            onSelectChord={handleSelectChord}
            centerSignal={centerSignal}
            onPlayLayer={handlePlayLayer}
            canPlayLayer={canPlayLayer}
            playingLayerIndex={playingLayerIndex}
          />
        </main>

        {isSuggestionsOpen && (
          <aside className="suggestions-sidebar" aria-label="Chord suggestions">
            <div className="sidebar-header">
              <h2>Chord Suggestions</h2>
              <button
                type="button"
                className="icon-close"
                aria-label="Hide suggestions panel"
                onClick={() => setIsSuggestionsOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="sidebar-content">
              <section className="sidebar-section">
                <p className="section-label">Selected chord</p>
                <p className="section-value">{selectedChordLabel}</p>
              </section>

              <section className="sidebar-section sidebar-status">
                <div className="section-head-row">
                  <strong>Available options</strong>
                  <span>{suggestionCountLabel}</span>
                </div>

                {error ? (
                  <div className="status-card error">{error}</div>
                ) : (
                  <div className="status-card">{info}</div>
                )}
              </section>

              <section className="sidebar-section sidebar-list">
                {suggestions.length === 0 ? (
                  <div className="empty">No suggestions yet.</div>
                ) : filteredSuggestions.length === 0 ? (
                  <div className="empty">No suggestions for the selected chord.</div>
                ) : (
                  filteredSuggestions.map((suggestion) => {
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
              </section>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
