/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Download, Minus, MousePointer2, Plus, PlusCircle, RefreshCw } from 'lucide-react';
import TranslucentFretboard, { ChordPickerCard, FretboardOverlapData } from './guitar';

interface TreeNode {
  id: string;
  label: string;
  children?: TreeNode[];
  initialX?: number;
  initialY?: number;
  isPreview?: boolean;
}

interface SuggestionItem {
  symbol: string;
  roman: string;
  label: string;
  why: string;
}

interface ChordSuggestion {
  index: number;
  input: string;
  roman: string;
  key: string;
  items: SuggestionItem[];
}

interface SuggestionResponse {
  input_chords: string[];
  inferred_keys: string[];
  suggestions: ChordSuggestion[];
}

interface LeafChordEntry {
  nodeId: string;
  label: string;
  x: number;
  barIndex: number;
  leafIndex: number;
}

interface KeyRegionCloud {
  regionIndex: number;
  startBarIndex: number;
  endBarIndex: number;
  key: string;
  startLeafIndex?: number;
  endLeafIndex?: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  type: 'background' | 'root';
  nodeId?: string;
}

type InteractionMode = 'pointer' | 'adder';

type PositionedNode = d3.HierarchyPointNode<TreeNode> & {
  layoutX: number;
  layoutY: number;
  subtreeMinX: number;
  subtreeMaxX: number;
};

type PositionedLink = {
  source: PositionedNode;
  target: PositionedNode;
};

const VIEWBOX_WIDTH = 1800;
const VIEWBOX_HEIGHT = 1100;
const MARGIN = { top: 140, right: 180, bottom: 220, left: 180 };
const HORIZONTAL_STEP = 110;
const LAYER_GAP = 160;
const BAR_GAP = 100;
const MIN_BAR_WIDTH = 160;
const NODE_CORNER_RADIUS = 20;
const TRANSITION_MS = 350;
const KEY_REGION_LABEL_FONT_SIZE = 11;
const CHORD_NODE_FONT_SIZE = 15;
const CHORD_NODE_FONT_WEIGHT = 500;
const CHORD_NODE_MIN_WIDTH = 64;
const CHORD_NODE_MIN_HEIGHT = 44;
const CHORD_NODE_PADDING_X = 10;
const CHORD_NODE_PADDING_Y = 6;

// Tunable visual parameters for key-region clouds.
// cloudHorizontalPadding: extra horizontal space beyond the region subtree width.
// cloudTopOffset: moves the cloud up/down relative to the root row (negative = higher).
// cloudBottomExtra: extra space below the terminal chord labels.
// cloudCornerRadius: roundness of the territory bubble.
// cloudFillOpacity/cloudStrokeOpacity: transparency balance of cloud fill and outline.
// cloudStrokeWidth: bubble border thickness.
// cloudLabelXInset/cloudLabelY: key label position inside each cloud.
const KEY_REGION_VISUALS = {
  cloudHorizontalPadding: 48,
  cloudTopOffset: -58,
  cloudBottomExtra: 72,
  cloudCornerRadius: 36,
  cloudFillOpacity: 0.2,
  cloudStrokeOpacity: 0.45,
  cloudStrokeWidth: 1.2,
  cloudLabelXInset: 18,
  cloudLabelY: -22,
} as const;

// Muted palette; clouds cycle by contiguous key-region index (not by key name).
const KEY_REGION_COLORS = ['#c8d3e0', '#d9d2c6', '#ccd9cf', '#d5cfe0', '#d8d8c8', '#c9d9d9'];

const MUSICAL_LABELS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°', 'V⁷', 'ii⁷', 'vi⁷', 'IV⁶', 'I⁶', 'V/V', 'V/IV'];
const CHORD_NAMES = ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim', 'G7', 'Dm7', 'Am7', 'F6', 'Cmaj7', 'Fm', 'Gm7'];
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
const resolveApiUrl = (path: string, specific?: string) => {
  const direct = specific?.trim();
  if (direct) return direct;
  if (API_BASE_URL) return `${API_BASE_URL.replace(/\/+$/, '')}${path}`;
  return path;
};
const PROGRESSION_API_URL = resolveApiUrl('/progression', import.meta.env.VITE_PROGRESSION_API_URL as string | undefined);
const SUGGESTIONS_API_URL = resolveApiUrl('/suggestions', import.meta.env.VITE_SUGGESTIONS_API_URL as string | undefined);
const OVERLAP_API_URL = resolveApiUrl('/fretboard-overlap', import.meta.env.VITE_OVERLAP_API_URL as string | undefined);
const CHORD_IDENTIFY_API_URL = resolveApiUrl('/identify-chord', import.meta.env.VITE_CHORD_IDENTIFY_URL as string | undefined);

const EXPANSION_OPTIONS: Record<string, string[][]> = {
  I: [['vi', 'ii', 'V', 'I'], ['IV', 'vii°', 'iii', 'vi'], ['I', 'V', 'vi', 'IV']],
  V: [['ii', 'V', 'I', 'V'], ['vi', 'IV', 'I', 'V'], ['V/V', 'V', 'ii', 'V']],
  ii: [['vi', 'ii', 'V/V', 'V'], ['I', 'vi', 'ii', 'V'], ['ii⁷', 'V⁷', 'I', 'ii']],
  IV: [['I', 'IV', 'V', 'I'], ['ii', 'V', 'I', 'IV'], ['IV⁶', 'V⁷', 'I', 'IV']],
  vi: [['iii', 'vi', 'ii', 'V'], ['I', 'V', 'vi', 'iii'], ['vi⁷', 'ii⁷', 'V⁷', 'I']],
  root: [['I', 'IV', 'V', 'I'], ['vi', 'ii', 'V', 'I']],
};

const cloneTrees = (trees: TreeNode[]) => JSON.parse(JSON.stringify(trees)) as TreeNode[];

const generateRandomLabel = (isLeaf: boolean) => {
  const list = isLeaf ? CHORD_NAMES : MUSICAL_LABELS;
  return list[Math.floor(Math.random() * list.length)];
};

const getTreeDepth = (node: TreeNode): number => {
  if (!node.children || node.children.length === 0) {
    return 1;
  }

  return 1 + Math.max(...node.children.map(getTreeDepth));
};

const getMaxDepth = (trees: TreeNode[]) => {
  if (trees.length === 0) {
    return 1;
  }

  return Math.max(...trees.map(getTreeDepth));
};

const estimateLabelSpan = (label: string) => Math.max(CHORD_NODE_MIN_WIDTH, label.length * 7.2 + CHORD_NODE_PADDING_X * 2);

const getNodeHalfWidth = (node: d3.HierarchyNode<TreeNode>) => {
  return estimateLabelSpan(node.data.label) / 2;
};

const getNodeWidth = (node: d3.HierarchyNode<TreeNode>) => estimateLabelSpan(node.data.label);
const getNodeHeight = () => Math.max(CHORD_NODE_MIN_HEIGHT, CHORD_NODE_FONT_SIZE + CHORD_NODE_PADDING_Y * 2);

const translate = (x: number, y: number) => `translate(${x},${y})`;

const linkPath = (source: PositionedNode, target: PositionedNode) => {
  const midY = (source.layoutY + target.layoutY) / 2;
  return `M${source.layoutX},${source.layoutY} C${source.layoutX},${midY} ${target.layoutX},${midY} ${target.layoutX},${target.layoutY}`;
};

const buildDisplayTrees = (trees: TreeNode[], selectedNodeId: string | null, previewLabels: string[]) => {
  const displayTrees = cloneTrees(trees);

  if (!selectedNodeId || previewLabels.length === 0) {
    return displayTrees;
  }

  const injectGhosts = (node: TreeNode): boolean => {
    if (node.id === selectedNodeId) {
      const ghosts = previewLabels.map((label, index) => ({
        id: `ghost-${selectedNodeId}-${index}`,
        label,
        isPreview: true,
      }));

      node.children = node.children ? [...node.children, ...ghosts] : ghosts;
      return true;
    }

    if (!node.children) {
      return false;
    }

    return node.children.some(injectGhosts);
  };

  displayTrees.forEach(injectGhosts);
  return displayTrees;
};

const positionForest = (trees: TreeNode[], innerWidth: number) => {
  const hierarchyRoots = trees.map((tree) => d3.hierarchy<TreeNode>(tree));
  const treeLayout = d3
    .tree<TreeNode>()
    .nodeSize([HORIZONTAL_STEP, LAYER_GAP])
    .separation((left, right) => {
      const footprint = (getNodeHalfWidth(left) + getNodeHalfWidth(right)) / HORIZONTAL_STEP;

      if (left.data.isPreview && right.data.isPreview) {
        return 1.1 + footprint * 0.35;
      }

      return (left.parent === right.parent ? 1.45 : 1.95) + footprint * 0.35;
    });

  hierarchyRoots.forEach(treeLayout);

  const layoutItems = hierarchyRoots.map((root, index) => {
    const nodes = root.descendants() as PositionedNode[];
    const minX = d3.min(nodes, (node) => node.x - getNodeHalfWidth(node)) ?? 0;
    const maxX = d3.max(nodes, (node) => node.x + getNodeHalfWidth(node)) ?? 0;

    return {
      root: root as PositionedNode,
      nodes,
      minX,
      maxX,
      width: Math.max(maxX - minX, MIN_BAR_WIDTH),
      desiredCenter:
        typeof trees[index].initialX === 'number'
          ? trees[index].initialX!
          : index * (MIN_BAR_WIDTH + BAR_GAP),
      center: 0,
    };
  });

  const packedItems = [...layoutItems].sort((left, right) => left.desiredCenter - right.desiredCenter);
  let previousRight = Number.NEGATIVE_INFINITY;

  packedItems.forEach((item) => {
    const halfWidth = item.width / 2;
    const minimumCenter =
      previousRight === Number.NEGATIVE_INFINITY ? item.desiredCenter : previousRight + BAR_GAP + halfWidth;

    item.center = Math.max(item.desiredCenter, minimumCenter);
    previousRight = item.center + halfWidth;
  });

  const globalMin = d3.min(packedItems, (item) => item.center + item.minX) ?? 0;
  const globalMax = d3.max(packedItems, (item) => item.center + item.maxX) ?? innerWidth;
  const contentWidth = Math.max(globalMax - globalMin, MIN_BAR_WIDTH);
  const hasManualPlacement = trees.some((tree) => typeof tree.initialX === 'number');
  const offsetX = hasManualPlacement
    ? 0
    : contentWidth < innerWidth
      ? (innerWidth - contentWidth) / 2 - globalMin
      : -globalMin;

  let maxDepth = 0;

  layoutItems.forEach((item) => {
    item.nodes.forEach((node) => {
      node.layoutX = node.x + item.center + offsetX;
      node.layoutY = node.y;
      node.subtreeMinX = node.layoutX - getNodeHalfWidth(node);
      node.subtreeMaxX = node.layoutX + getNodeHalfWidth(node);
      maxDepth = Math.max(maxDepth, node.depth);
    });
  });

  const updateBounds = (node: PositionedNode) => {
    let minX = node.layoutX - getNodeHalfWidth(node);
    let maxX = node.layoutX + getNodeHalfWidth(node);

    const children = (node.children ?? []) as PositionedNode[];
    children.forEach((child) => {
      updateBounds(child);
      minX = Math.min(minX, child.subtreeMinX);
      maxX = Math.max(maxX, child.subtreeMaxX);
    });

    node.subtreeMinX = minX;
    node.subtreeMaxX = maxX;
  };

  layoutItems.forEach((item) => updateBounds(item.root));

  const nodes = layoutItems.flatMap((item) => item.nodes);
  const links = layoutItems.flatMap((item) =>
    item.root.links().map((link) => ({
      source: link.source as PositionedNode,
      target: link.target as PositionedNode,
    })),
  );
  const leaves = layoutItems.flatMap((item) =>
    item.root
      .leaves()
      .map((leaf) => leaf as PositionedNode)
      .filter((leaf) => !leaf.data.isPreview),
  );
  const roots = layoutItems.map((item) => item.root);

  return {
    nodes,
    links,
    leaves,
    roots,
    terminalY: (maxDepth + 1) * LAYER_GAP,
  };
};

export default function App() {
  const svgRef = useRef<SVGSVGElement>(null);
  const nodePositionRef = useRef(new Map<string, { x: number; y: number }>());
  const autoSuggestAfterTreeChangeRef = useRef(false);

  const [trees, setTrees] = useState<TreeNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedGhostId, setSelectedGhostId] = useState<string | null>(null);
  const [previewOptionIndex, setPreviewOptionIndex] = useState(0);
  const [currentPreviewLabels, setCurrentPreviewLabels] = useState<string[]>([]);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('pointer');
  const [chordPicker, setChordPicker] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const [isSendingProgression, setIsSendingProgression] = useState(false);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [leafSubstitutionsByNodeId, setLeafSubstitutionsByNodeId] = useState<Record<string, string[]>>({});
  const [keyRegionClouds, setKeyRegionClouds] = useState<KeyRegionCloud[]>([]);
  const [fretboardOverlap, setFretboardOverlap] = useState<FretboardOverlapData | null>(null);
  const [isLoadingOverlap, setIsLoadingOverlap] = useState(false);
  const [overlapError, setOverlapError] = useState<string | null>(null);

  const treeDepth = getMaxDepth(trees);

  const setPreviewLabelsIfChanged = (nextLabels: string[]) => {
    setCurrentPreviewLabels((prevLabels) => {
      const sameLength = prevLabels.length === nextLabels.length;
      const sameValues = sameLength && prevLabels.every((value, index) => value === nextLabels[index]);
      return sameValues ? prevLabels : nextLabels;
    });
  };

  const screenToDiagramPoint = (screenX: number, screenY: number) => {
    const svg = svgRef.current;
    if (!svg) {
      return { x: 0, y: 0 };
    }

    const mainGroup = svg.querySelector<SVGGElement>('g.main-group');
    if (mainGroup) {
      const point = svg.createSVGPoint();
      point.x = screenX;
      point.y = screenY;

      const groupMatrix = mainGroup.getScreenCTM();
      if (groupMatrix) {
        const local = point.matrixTransform(groupMatrix.inverse());
        return { x: local.x, y: local.y };
      }
    }

    const point = svg.createSVGPoint();
    point.x = screenX;
    point.y = screenY;
    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) {
      return { x: 0, y: 0 };
    }
    const svgPoint = point.matrixTransform(screenMatrix.inverse());
    return {
      x: svgPoint.x - MARGIN.left,
      y: svgPoint.y - MARGIN.top,
    };
  };

  useEffect(() => {
    if (!selectedNodeId) {
      setPreviewLabelsIfChanged([]);
      return;
    }

    let target: d3.HierarchyNode<TreeNode> | undefined;

    for (const tree of trees) {
      const root = d3.hierarchy(tree);
      const found = root.descendants().find((node) => node.data.id === selectedNodeId);
      if (found) {
        target = found;
        break;
      }
    }

    if (!target || !target.parent) {
      setPreviewLabelsIfChanged([]);
      return;
    }

    const isLeaf = !target.children || target.children.length === 0;
    if (isLeaf) {
      const substitutions = leafSubstitutionsByNodeId[target.data.id] || [];
      if (substitutions.length > 0) {
        setPreviewLabelsIfChanged(substitutions);
        return;
      }
    }

    const options = getOptions(target.data.label);
    const currentOption = options[previewOptionIndex % options.length];

    if (!currentOption) {
      setPreviewLabelsIfChanged([]);
      return;
    }

    const labels =
      currentOption[0] === 'Unitary Substitute'
        ? Array.from({ length: 4 }, () => generateRandomLabel(true))
        : currentOption;

    setPreviewLabelsIfChanged(labels);
  }, [leafSubstitutionsByNodeId, previewOptionIndex, selectedNodeId, trees]);

  const handleExpansion = (nodeId: string, expansionLabels: string[]) => {
    const nextTrees = cloneTrees(trees);
    let idCounter = Date.now();

    const findAndReplace = (node: TreeNode): boolean => {
      if (node.id === nodeId) {
        node.children = expansionLabels.map((label, index) => ({
          id: `${idCounter++}-${index}`,
          label,
        }));
        return true;
      }

      if (!node.children) {
        return false;
      }

      return node.children.some(findAndReplace);
    };

    nextTrees.some(findAndReplace);
    setTrees(nextTrees);
    setKeyRegionClouds([]);
    setFretboardOverlap(null);
    setOverlapError(null);
    setSelectedNodeId(null);
    setSelectedGhostId(null);
  };

  const addAutumnLeavesSection = () => {
    const section = [
      ['Am7b5', 'D7'],
      ['Gm'],
      ['C7'],
      ['Fmaj7'],
      ['Bm7b5', 'E7'],
      ['Am'],
      ['D7'],
      ['Gm'],
    ];

    const baseBarNumber = trees.length + 1;
    const now = Date.now();
    const newBars: TreeNode[] = section.map((barChords, barOffset) => {
      const barId = `root-${now}-${barOffset}`;
      return {
        id: barId,
        label: `Bar ${baseBarNumber + barOffset}`,
        children: barChords.map((chord, chordIndex) => ({
          id: `${barId}-chord-${chordIndex}`,
          label: chord,
        })),
      };
    });

    setTrees((prev) => [...prev, ...newBars]);
    setKeyRegionClouds([]);
    setFretboardOverlap(null);
    setOverlapError(null);
    setSelectedNodeId(null);
    setSelectedGhostId(null);
  };

  const removeLayer = () => {
    if (treeDepth <= 1) {
      return;
    }

    const nextTrees = cloneTrees(trees);

    const removeDeepest = (node: TreeNode) => {
      if (!node.children || node.children.length === 0) {
        return;
      }

      const allChildrenAreLeaves = node.children.every((child) => !child.children || child.children.length === 0);
      if (allChildrenAreLeaves) {
        delete node.children;
        return;
      }

      node.children.forEach(removeDeepest);
    };

    nextTrees.forEach(removeDeepest);
    setTrees(nextTrees);
    setKeyRegionClouds([]);
    setFretboardOverlap(null);
    setOverlapError(null);
    setSelectedNodeId(null);
    setSelectedGhostId(null);
  };

  const resetTree = () => {
    nodePositionRef.current.clear();
    setTrees([]);
    setKeyRegionClouds([]);
    setFretboardOverlap(null);
    setOverlapError(null);
    setSelectedNodeId(null);
    setSelectedGhostId(null);
    setContextMenu(null);
    setChordPicker(null);
    setSendStatus(null);
  };

  const addBar = (screenX: number, screenY: number) => {
    const { x } = screenToDiagramPoint(screenX, screenY);
    const nextTrees = [...trees];
    const nodeId = `root-${Date.now()}`;

    nextTrees.push({
      id: nodeId,
      label: `Bar ${nextTrees.length + 1}`,
      initialX: x,
      initialY: 0,
    });

    setTrees(nextTrees);
    setKeyRegionClouds([]);
    setFretboardOverlap(null);
    setOverlapError(null);
    setContextMenu(null);
    setChordPicker({ nodeId, x: screenX, y: screenY });
  };

  const addChord = (nodeId: string, chordLabel: string) => {
    if (!chordLabel.trim()) {
      return;
    }

    const nextTrees = cloneTrees(trees);

    const findAndAdd = (node: TreeNode): boolean => {
      if (node.id === nodeId) {
        const chord: TreeNode = {
          id: `chord-${Date.now()}`,
          label: chordLabel.trim(),
        };

        node.children = node.children ? [...node.children, chord] : [chord];
        return true;
      }

      if (!node.children) {
        return false;
      }

      return node.children.some(findAndAdd);
    };

    nextTrees.some(findAndAdd);
    setTrees(nextTrees);
    setKeyRegionClouds([]);
    setFretboardOverlap(null);
    setOverlapError(null);
    setContextMenu(null);
    setChordPicker(null);
    autoSuggestAfterTreeChangeRef.current = true;
  };

  const findNodeLabelById = (nodeId: string): string | null => {
    const walk = (node: TreeNode): string | null => {
      if (node.id === nodeId) {
        return node.label;
      }
      if (!node.children) {
        return null;
      }
      for (const child of node.children) {
        const found = walk(child);
        if (found) {
          return found;
        }
      }
      return null;
    };

    for (const tree of trees) {
      const found = walk(tree);
      if (found) {
        return found;
      }
    }

    return null;
  };

  const getLeafEntriesInDisplayOrder = (): LeafChordEntry[] => {
    const innerWidth = VIEWBOX_WIDTH - MARGIN.left - MARGIN.right;
    const layout = positionForest(trees, innerWidth);

    const leafMetaById = new Map<string, { barIndex: number; leafIndex: number }>();
    trees.forEach((tree, barIndex) => {
      let leafIndex = 0;
      const walk = (node: TreeNode) => {
        if (!node.children || node.children.length === 0) {
          if (node.id.startsWith('root-')) {
            return;
          }
          leafMetaById.set(node.id, { barIndex, leafIndex });
          leafIndex += 1;
          return;
        }
        node.children.forEach(walk);
      };
      walk(tree);
    });

    return layout.leaves
      .filter((leaf) => Boolean(leaf.parent))
      .map((leaf) => {
        const meta = leafMetaById.get(leaf.data.id);
        return {
          nodeId: leaf.data.id,
          label: leaf.data.label,
          x: leaf.layoutX,
          barIndex: meta?.barIndex ?? 0,
          leafIndex: meta?.leafIndex ?? 0,
        };
      })
      .sort((a, b) => a.x - b.x);
  };

  const getLeafChordProgression = () => getLeafEntriesInDisplayOrder().map((item) => item.label);

  const getCurrentLeafNodeIds = () => {
    const ids = new Set<string>();
    const walk = (node: TreeNode) => {
      if (!node.children || node.children.length === 0) {
        if (!node.id.startsWith('root-')) {
          ids.add(node.id);
        }
        return;
      }
      node.children.forEach(walk);
    };
    trees.forEach(walk);
    return ids;
  };

  const sendProgression = async () => {
    const chords = getLeafChordProgression();
    if (chords.length === 0) {
      setSendStatus('No leaf chords to send.');
      return;
    }

    setIsSendingProgression(true);
    setSendStatus('Sending progression...');

    try {
      const response = await fetch(PROGRESSION_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chords }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const detail = typeof errorBody?.detail === 'string' ? errorBody.detail : `HTTP ${response.status}`;
        throw new Error(detail);
      }

      const body = await response.json();
      console.log('Sent progression:', chords);
      console.log('Backend response:', body);
      setSendStatus(`Sent ${chords.length} chord${chords.length === 1 ? '' : 's'}.`);
    } catch (error) {
      console.error('Failed to send progression:', error);
      setSendStatus(`Send failed. Is backend running at ${PROGRESSION_API_URL}?`);
    } finally {
      setIsSendingProgression(false);
    }
  };

  const fetchSuggestions = async () => {
    const leafEntries = getLeafEntriesInDisplayOrder();
    const chords = leafEntries.map((entry) => entry.label);

    if (chords.length === 0) {
      console.log('No leaf chords to suggest from.');
      return;
    }

    setIsLoadingSuggestions(true);
    console.log('Fetching suggestions for progression:', chords);

    try {
      const response = await fetch(SUGGESTIONS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chords }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as SuggestionResponse;
      console.log('Suggestion response:', body);
      console.log(
        'Suggestion key stream:',
        body.suggestions.map((entry, index) => ({
          index,
          input: entry.input,
          key: entry.key,
          inferred_key: body.inferred_keys[index],
        })),
      );

      const substitutionsByLeafId: Record<string, string[]> = {};
      leafEntries.forEach((entry) => {
        substitutionsByLeafId[entry.nodeId] = [];
      });
      body.suggestions.forEach((entry, index) => {
        const leaf = leafEntries[index];
        if (!leaf) {
          return;
        }
        const uniqueSymbols = Array.from(new Set(entry.items.map((item) => item.symbol).filter(Boolean)));
        substitutionsByLeafId[leaf.nodeId] = uniqueSymbols;
      });
      setLeafSubstitutionsByNodeId(substitutionsByLeafId);

      const keysByBar = new Map<number, string[]>();
      leafEntries.forEach((entry, index) => {
        const key = body.suggestions[index]?.key || body.inferred_keys[index];
        if (!key) {
          console.warn('Missing key for leaf entry:', {
            index,
            nodeId: entry.nodeId,
            chord: entry.label,
            barIndex: entry.barIndex,
          });
          return;
        }
        const existing = keysByBar.get(entry.barIndex) || [];
        existing.push(key);
        keysByBar.set(entry.barIndex, existing);
      });
      console.log(
        'Leaf entries in display order:',
        leafEntries.map((entry, index) => ({
          index,
          nodeId: entry.nodeId,
          chord: entry.label,
          barIndex: entry.barIndex,
          leafIndex: entry.leafIndex,
          resolvedKey: body.suggestions[index]?.key || body.inferred_keys[index] || null,
        })),
      );
      console.log('keysByBar:', Array.from(keysByBar.entries()));

      const barKeys = trees.map((_, barIndex) => {
        const keyList = keysByBar.get(barIndex) || [];
        if (keyList.length === 0) {
          return null;
        }
        const counts = new Map<string, number>();
        keyList.forEach((key) => counts.set(key, (counts.get(key) || 0) + 1));
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      });
      console.log('barKeys:', barKeys);

      const leafKeys = leafEntries.map((entry, index) => ({
        key: body.suggestions[index]?.key || body.inferred_keys[index] || null,
        barIndex: entry.barIndex,
      }));
      console.log('leafKeys:', leafKeys);

      const regions: KeyRegionCloud[] = [];
      let currentKey: string | null = null;
      let currentStartLeaf = -1;
      let regionIndex = 0;

      leafKeys.forEach((entry, leafIndex) => {
        if (!entry.key) {
          if (currentKey !== null) {
            const startBar = leafKeys[currentStartLeaf]?.barIndex ?? 0;
            const endBar = leafKeys[Math.max(currentStartLeaf, leafIndex - 1)]?.barIndex ?? startBar;
            regions.push({
              regionIndex,
              startBarIndex: startBar,
              endBarIndex: endBar,
              key: currentKey,
              startLeafIndex: currentStartLeaf,
              endLeafIndex: leafIndex - 1,
            });
            regionIndex += 1;
            currentKey = null;
            currentStartLeaf = -1;
          }
          return;
        }

        if (currentKey === null) {
          currentKey = entry.key;
          currentStartLeaf = leafIndex;
          return;
        }

        if (entry.key !== currentKey) {
          const startBar = leafKeys[currentStartLeaf]?.barIndex ?? 0;
          const endBar = leafKeys[Math.max(currentStartLeaf, leafIndex - 1)]?.barIndex ?? startBar;
          regions.push({
            regionIndex,
            startBarIndex: startBar,
            endBarIndex: endBar,
            key: currentKey,
            startLeafIndex: currentStartLeaf,
            endLeafIndex: leafIndex - 1,
          });
          regionIndex += 1;
          currentKey = entry.key;
          currentStartLeaf = leafIndex;
        }
      });

      if (currentKey !== null) {
        const startBar = leafKeys[currentStartLeaf]?.barIndex ?? 0;
        const endBar = leafKeys[leafKeys.length - 1]?.barIndex ?? startBar;
        regions.push({
          regionIndex,
          startBarIndex: startBar,
          endBarIndex: endBar,
          key: currentKey,
          startLeafIndex: currentStartLeaf,
          endLeafIndex: leafKeys.length - 1,
        });
      }

      console.log('Detected key-region clouds:', regions);
      setKeyRegionClouds(regions);
    } catch (error) {
      console.error('Failed to fetch suggestions:', error);
    } finally {
      setIsLoadingSuggestions(false);
    }
  };

  const fetchFretboardOverlap = async (chordA: string, chordB: string) => {
    setIsLoadingOverlap(true);
    setOverlapError(null);

    try {
      const response = await fetch(OVERLAP_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chord_a: chordA, chord_b: chordB }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const detail = typeof errorBody?.detail === 'string' ? errorBody.detail : `HTTP ${response.status}`;
        throw new Error(detail);
      }

      const body = (await response.json()) as FretboardOverlapData;
      setFretboardOverlap(body);
      console.log('Fretboard overlap:', body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown overlap error.';
      console.error('Failed to fetch fretboard overlap:', error);
      setOverlapError(message);
      setFretboardOverlap(null);
    } finally {
      setIsLoadingOverlap(false);
    }
  };

  useEffect(() => {
    if (!svgRef.current) {
      return;
    }

    const width = VIEWBOX_WIDTH;
    const innerWidth = width - MARGIN.left - MARGIN.right;

    const svg = d3.select(svgRef.current);

    // Grid pattern for depth
    const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');
    if (defs.select('#grid-pattern').empty()) {
      const pattern = defs
        .append('pattern')
        .attr('id', 'grid-pattern')
        .attr('width', 40)
        .attr('height', 40)
        .attr('patternUnits', 'userSpaceOnUse');

      pattern.append('circle').attr('cx', 2).attr('cy', 2).attr('r', 1).attr('fill', '#e5dcd0').attr('opacity', 0.6);
    }

    const zoomGroup =
      svg.select<SVGGElement>('g.zoom-group').empty()
        ? svg.append('g').attr('class', 'zoom-group')
        : svg.select<SVGGElement>('g.zoom-group');

    // Background rect for grid
    if (zoomGroup.select('rect.grid-bg').empty()) {
      zoomGroup
        .insert('rect', ':first-child')
        .attr('class', 'grid-bg')
        .attr('x', -VIEWBOX_WIDTH * 2)
        .attr('y', -VIEWBOX_HEIGHT * 2)
        .attr('width', VIEWBOX_WIDTH * 5)
        .attr('height', VIEWBOX_HEIGHT * 5)
        .attr('fill', 'url(#grid-pattern)')
        .attr('pointer-events', 'none');
    }

    const mainGroup =
      zoomGroup.select<SVGGElement>('g.main-group').empty()
        ? zoomGroup.append('g').attr('class', 'main-group').attr('transform', translate(MARGIN.left, MARGIN.top))
        : zoomGroup.select<SVGGElement>('g.main-group');

    const cloudLayer =
      mainGroup.select<SVGGElement>('g.key-region-cloud-layer').empty()
        ? mainGroup.insert('g', ':first-child').attr('class', 'key-region-cloud-layer pointer-events-none')
        : mainGroup.select<SVGGElement>('g.key-region-cloud-layer');

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 3.0])
      .on('zoom', (event) => {
        zoomGroup.attr('transform', event.transform.toString());
      });

    svg
      .call(zoom)
      .on('dblclick.zoom', null)
      .on('click', (event) => {
        if (event.target !== svg.node() || event.defaultPrevented) {
          return;
        }

        if (interactionMode === 'adder') {
          addBar(event.clientX, event.clientY);
          return;
        }

        setSelectedNodeId(null);
        setSelectedGhostId(null);
        setContextMenu(null);
        setChordPicker(null);
      })
      .on('contextmenu', (event) => {
        if (event.target !== svg.node()) {
          return;
        }

        event.preventDefault();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          type: 'background',
        });
      });

    const displayTrees = buildDisplayTrees(trees, selectedNodeId, currentPreviewLabels);
    const { nodes, links, leaves, roots, terminalY } = positionForest(displayTrees, innerWidth);
    const previousPositions = nodePositionRef.current;
    const transition = d3.transition().duration(TRANSITION_MS).ease(d3.easeCubicOut);

    const getStartingPoint = (node: PositionedNode) => {
      const existing = previousPositions.get(node.data.id);
      if (existing) {
        return existing;
      }

      if (node.parent) {
        const parentPoint = previousPositions.get(node.parent.data.id);
        if (parentPoint) {
          return parentPoint;
        }
      }

      return { x: node.layoutX, y: node.layoutY };
    };

    const cloudSelection = cloudLayer
      .selectAll<SVGGElement, KeyRegionCloud>('g.key-region-cloud')
      .data(keyRegionClouds, (region: any) => `region-${region.regionIndex}-${region.startBarIndex}-${region.endBarIndex}`);

    cloudSelection.exit().transition(transition).attr('opacity', 0).remove();

    const cloudEnter = cloudSelection
      .enter()
      .append('g')
      .attr('class', 'key-region-cloud pointer-events-none')
      .attr('opacity', 0);

    cloudEnter.append('rect');
    cloudEnter
      .append('text')
      .attr('class', 'scientific-text')
      .attr('font-size', KEY_REGION_LABEL_FONT_SIZE)
      .attr('font-style', 'italic');

    const cloudUpdate = cloudEnter.merge(cloudSelection as any);
    const orderedLeaves = [...leaves].sort((a, b) => a.layoutX - b.layoutX);

    cloudUpdate.each(function (region: KeyRegionCloud) {
      let minX = 0;
      let maxX = 0;

      if (typeof region.startLeafIndex === 'number' && typeof region.endLeafIndex === 'number') {
        const regionLeaves = orderedLeaves.slice(region.startLeafIndex, region.endLeafIndex + 1);
        if (regionLeaves.length === 0) {
          return;
        }
        minX = d3.min(regionLeaves, (leaf) => leaf.layoutX - getNodeHalfWidth(leaf)) ?? 0;
        maxX = d3.max(regionLeaves, (leaf) => leaf.layoutX + getNodeHalfWidth(leaf)) ?? 0;
      } else {
        const regionRoots = roots.slice(region.startBarIndex, region.endBarIndex + 1);
        if (regionRoots.length === 0) {
          return;
        }
        minX = d3.min(regionRoots, (root) => root.subtreeMinX) ?? 0;
        maxX = d3.max(regionRoots, (root) => root.subtreeMaxX) ?? 0;
      }

      const yTop = KEY_REGION_VISUALS.cloudTopOffset;
      const yBottom = terminalY + KEY_REGION_VISUALS.cloudBottomExtra;
      const x = minX - KEY_REGION_VISUALS.cloudHorizontalPadding;
      const widthRect = Math.max(24, maxX - minX + KEY_REGION_VISUALS.cloudHorizontalPadding * 2);
      const heightRect = Math.max(24, yBottom - yTop);
      const color = KEY_REGION_COLORS[region.regionIndex % KEY_REGION_COLORS.length];

      const group = d3.select(this);
      group
        .select('rect')
        .transition(transition)
        .attr('x', x)
        .attr('y', yTop)
        .attr('width', widthRect)
        .attr('height', heightRect)
        .attr('rx', KEY_REGION_VISUALS.cloudCornerRadius)
        .attr('ry', KEY_REGION_VISUALS.cloudCornerRadius)
        .attr('fill', color)
        .attr('fill-opacity', KEY_REGION_VISUALS.cloudFillOpacity)
        .attr('stroke', color)
        .attr('stroke-opacity', KEY_REGION_VISUALS.cloudStrokeOpacity)
        .attr('stroke-width', KEY_REGION_VISUALS.cloudStrokeWidth);

      group
        .select('text')
        .transition(transition)
        .attr('x', x + KEY_REGION_VISUALS.cloudLabelXInset)
        .attr('y', KEY_REGION_VISUALS.cloudLabelY)
        .attr('fill', '#4b5563')
        .text(region.key);
    });

    cloudUpdate.transition(transition).attr('opacity', 1);


    const linkSelection = mainGroup
      .selectAll<SVGPathElement, PositionedLink>('path.link')
      .data(links, (link: any) => `${link.source.data.id}-${link.target.data.id}`);

    linkSelection.exit().transition(transition).attr('opacity', 0).remove();

    const linkEnter = linkSelection
      .enter()
      .append('path')
      .attr('class', 'link pointer-events-none')
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')
      .attr('opacity', 0)
      .attr('d', (link) => {
        const sourcePoint = getStartingPoint(link.source);
        return `M${sourcePoint.x},${sourcePoint.y} C${sourcePoint.x},${sourcePoint.y} ${sourcePoint.x},${sourcePoint.y} ${sourcePoint.x},${sourcePoint.y}`;
      });

    linkEnter
      .merge(linkSelection as any)
      .attr('stroke', (link: PositionedLink) => (link.target.data.isPreview ? '#b37a3c' : '#c3b091'))
      .attr('stroke-width', (link: PositionedLink) => (link.target.data.isPreview ? 1.0 : 1.2))
      .attr('stroke-dasharray', (link: PositionedLink) => (link.target.data.isPreview ? '3 5' : 'none'))
      .transition(transition)
      .attr('opacity', 1)
      .attr('d', (link: PositionedLink) => linkPath(link.source, link.target));

    const nodeSelection = mainGroup
      .selectAll<SVGGElement, PositionedNode>('g.node')
      .data(nodes, (node: any) => node.data.id);

    nodeSelection
      .exit()
      .transition(transition)
      .attr('opacity', 0)
      .attr('transform', (node: PositionedNode) => {
        const target = (node.parent as PositionedNode | null) ?? node;
        return translate(target.layoutX, target.layoutY);
      })
      .remove();

    const nodeEnter = nodeSelection
      .enter()
      .append('g')
      .attr('class', 'node')
      .attr('opacity', 0)
      .attr('transform', (node) => {
        const start = getStartingPoint(node);
        return translate(start.x, start.y);
      });

    nodeEnter.append('rect').attr('class', 'node-hit').attr('fill', 'transparent');
    nodeEnter.append('rect').attr('class', 'node-chip');

    nodeEnter
      .append('text')
      .attr('class', 'node-label scientific-text')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('pointer-events', 'none');

    const nodeUpdate = nodeEnter.merge(nodeSelection as any);

    nodeUpdate
      .style('cursor', (node: PositionedNode) => {
        if (interactionMode === 'adder') {
          return 'pointer';
        }

        return 'pointer';
      })
      .on('mouseenter', function (event: any, node: PositionedNode) {
        if (node.data.id === selectedNodeId || node.data.id === selectedGhostId) {
          return;
        }
        const target = d3.select(this).select<SVGRectElement>('rect.node-chip');
        target
          .transition()
          .duration(120)
          .attr('fill', '#f4e7d4')
          .attr('stroke', '#b67a3c')
          .style('filter', 'drop-shadow(0 2px 8px rgba(0,0,0,0.08))');
      })
      .on('mouseleave', function (event: any, node: PositionedNode) {
        if (node.data.id === selectedNodeId || node.data.id === selectedGhostId) {
          return;
        }
        const target = d3.select(this).select<SVGRectElement>('rect.node-chip');
        target
          .transition()
          .duration(120)
          .attr('fill', '#fff4e4')
          .attr('stroke', '#bfa388')
          .style('filter', 'none');
      })
      .on('click', (event: any, node: PositionedNode) => {
        event.stopPropagation();
        setContextMenu(null);

        if (interactionMode === 'adder') {
          if (!node.data.isPreview) {
            setChordPicker({
              nodeId: node.data.id,
              x: event.clientX,
              y: event.clientY,
            });
          }
          return;
        }

        if (!node.parent) {
          return;
        }

        if (node.data.isPreview) {
          if (selectedGhostId === node.data.id && selectedNodeId) {
            handleExpansion(selectedNodeId, [node.data.label]);
          } else {
            setSelectedGhostId(node.data.id);
            const selectedLabel = selectedNodeId ? findNodeLabelById(selectedNodeId) : null;
            const hasSuggestionSubstitutions = selectedNodeId
              ? (leafSubstitutionsByNodeId[selectedNodeId]?.length ?? 0) > 0
              : false;
            if (selectedLabel && hasSuggestionSubstitutions) {
              void fetchFretboardOverlap(selectedLabel, node.data.label);
            } else {
              setFretboardOverlap(null);
              setOverlapError(null);
            }
          }
          return;
        }

        setSelectedNodeId(node.data.id);
        setSelectedGhostId(null);
        setOverlapError(null);
        setPreviewOptionIndex(0);
      })
      .on('contextmenu', (event: any, node: PositionedNode) => {
        event.preventDefault();
        event.stopPropagation();

        if (node.parent) {
          return;
        }

        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          type: 'root',
          nodeId: node.data.id,
        });
      });

    nodeUpdate.transition(transition).attr('opacity', 1).attr('transform', (node: PositionedNode) => translate(node.layoutX, node.layoutY));

    nodeUpdate
      .select<SVGRectElement>('rect.node-hit')
      .attr('x', (node: PositionedNode) => -Math.max(14, getNodeWidth(node) / 2))
      .attr('y', -CHORD_NODE_MIN_HEIGHT / 2)
      .attr('width', (node: PositionedNode) => Math.max(28, getNodeWidth(node)))
      .attr('height', CHORD_NODE_MIN_HEIGHT)
      .attr('rx', NODE_CORNER_RADIUS)
      .attr('ry', NODE_CORNER_RADIUS);

    nodeUpdate
      .select<SVGRectElement>('rect.node-chip')
      .transition(transition)
      .attr('x', (node: PositionedNode) => -getNodeWidth(node) / 2)
      .attr('y', -getNodeHeight() / 2)
      .attr('width', (node: PositionedNode) => getNodeWidth(node))
      .attr('height', getNodeHeight())
      .attr('rx', NODE_CORNER_RADIUS)
      .attr('ry', NODE_CORNER_RADIUS)
      .attr('fill', (node: PositionedNode) => {
        if (node.data.id === selectedGhostId) return '#e9d5b8';
        if (node.data.id === selectedNodeId) return '#ead2ad';
        return '#fffcf8';
      })
      .attr('stroke', (node: PositionedNode) => {
        if (node.data.id === selectedGhostId) return '#8c5e31';
        if (node.data.id === selectedNodeId) return '#a36d38';
        return '#dccab4';
      })
      .attr('stroke-width', (node: PositionedNode) => (node.data.id === selectedNodeId || node.data.id === selectedGhostId ? 2 : 1.2))
      .style('filter', (node: PositionedNode) =>
        node.data.id === selectedNodeId || node.data.id === selectedGhostId
          ? 'drop-shadow(0 4px 12px rgba(48,34,18,0.12))'
          : 'drop-shadow(0 2px 4px rgba(0,0,0,0.02))',
      );

    nodeUpdate
      .select<SVGTextElement>('text.node-label')
      .text((node: PositionedNode) => node.data.label)
      .transition(transition)
      .attr('x', 0)
      .attr('y', 0)
      .attr('opacity', 1)
      .attr('fill', '#3f3328')
      .attr('font-size', CHORD_NODE_FONT_SIZE)
      .attr('font-style', 'normal')
      .attr('font-weight', CHORD_NODE_FONT_WEIGHT)
      .attr('line-height', 1);

    const selectedNodes = nodeUpdate.filter(
      (node: PositionedNode) => node.data.id === selectedNodeId || node.data.id === selectedGhostId,
    );
    selectedNodes.raise();

    nodePositionRef.current = new Map(
      nodes.map((node) => [
        node.data.id,
        {
          x: node.layoutX,
          y: node.layoutY,
        },
      ]),
    );
  }, [currentPreviewLabels, interactionMode, keyRegionClouds, selectedGhostId, selectedNodeId, trees]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (contextMenu && !document.querySelector('.context-menu')?.contains(event.target as Node)) {
        setContextMenu(null);
      }

      if (chordPicker && !document.querySelector('.chord-picker-container')?.contains(event.target as Node)) {
        setChordPicker(null);
      }
    };

    window.addEventListener('mousedown', handleMouseDown);

    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [chordPicker, contextMenu]);

  useEffect(() => {
    const currentLeafNodeIds = getCurrentLeafNodeIds();
    setLeafSubstitutionsByNodeId((prev: Record<string, string[]>) => {
      const next: Record<string, string[]> = {};
      Object.entries(prev).forEach(([nodeId, substitutions]) => {
        if (currentLeafNodeIds.has(nodeId)) {
          next[nodeId] = substitutions;
        }
      });
      return next;
    });
  }, [trees]);

  useEffect(() => {
    if (!autoSuggestAfterTreeChangeRef.current) {
      return;
    }
    autoSuggestAfterTreeChangeRef.current = false;
    void fetchSuggestions();
  }, [trees]);

  const getOptions = (label: string) => {
    const baseLabel = label.split('_')[0];
    return EXPANSION_OPTIONS[baseLabel] || [['Unitary Substitute']];
  };

  const controlButtonClass =
    'inline-flex items-center gap-2 rounded-full border border-[#d8cdbf] bg-[#fffaf3] px-3 py-1.5 text-[11px] font-medium tracking-[0.07em] text-[#3f3328] shadow-[0_12px_30px_-24px_rgba(48,34,18,0.85)] transition-colors hover:bg-[#fff3e3]';

  return (
    <div
      className="min-h-[100dvh] overflow-hidden px-5 py-4 text-[#1f1a16]"
      style={{
        backgroundImage:
          'radial-gradient(circle at top, rgba(223, 203, 176, 0.6), rgba(248, 243, 236, 0.95) 45%, #f4efe7 100%)',
      }}
    >
      <div className="mx-auto flex h-[calc(100dvh-2rem)] w-full max-w-[1680px] flex-col gap-4">
        <div className="rounded-[24px] border border-[#e4d8c8] bg-[#fffaf2]/88 px-5 py-3 shadow-[0_20px_60px_-40px_rgba(49,35,18,0.6)] backdrop-blur">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-0.5 text-[9px] uppercase tracking-[0.3em] text-[#8a7661]">Deterministic Harmonic Grammar</p>
              <h1 className="scientific-text text-3xl leading-none tracking-tight text-[#241d18]">Harmonic Analysis Tree</h1>
            </div>

            <div className="max-w-xl text-right text-[11px] leading-relaxed text-[#6a5c4f]">
              Tidy-tree spacing with explicit bar packing keeps branches stable while preserving substitutions and key regions.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 border-t border-[#e8dccd] pt-2">
            <div className="mr-2 flex rounded-full border border-[#dacdbd] bg-white/80 p-1 shadow-inner">
              <button
                onClick={() => {
                  setInteractionMode('pointer');
                  setChordPicker(null);
                }}
                className={`rounded-full px-3 py-2 transition-colors ${interactionMode === 'pointer' ? 'bg-[#f0dfc5] text-[#5f3d1f]' : 'text-[#8c7a67] hover:text-[#5f3d1f]'
                  }`}
                title="Pointer Mode"
              >
                <MousePointer2 size={16} />
              </button>
              <button
                onClick={() => {
                  setInteractionMode('adder');
                  setSelectedNodeId(null);
                  setSelectedGhostId(null);
                }}
                className={`rounded-full px-3 py-2 transition-colors ${interactionMode === 'adder' ? 'bg-[#f0dfc5] text-[#5f3d1f]' : 'text-[#8c7a67] hover:text-[#5f3d1f]'
                  }`}
                title="Adder Mode"
              >
                <PlusCircle size={16} />
              </button>
            </div>

            <button onClick={addAutumnLeavesSection} className={controlButtonClass} title="Add an 8-bar Autumn Leaves sample section">
              <Plus size={14} /> Add Autumn Leaves
            </button>
            <button onClick={removeLayer} className={controlButtonClass}>
              <Minus size={14} /> Remove Layer
            </button>
            <button onClick={resetTree} className={controlButtonClass}>
              <RefreshCw size={14} /> Reset
            </button>
            <button onClick={sendProgression} disabled={isSendingProgression} className={`${controlButtonClass} disabled:opacity-50 disabled:cursor-not-allowed`}>
              <Download size={14} /> {isSendingProgression ? 'Sending...' : 'Send'}
            </button>
            <button onClick={fetchSuggestions} disabled={isLoadingSuggestions} className={`${controlButtonClass} disabled:opacity-50 disabled:cursor-not-allowed`}>
              {isLoadingSuggestions ? 'Suggesting...' : 'Suggest'}
            </button>

          </div>

          {sendStatus && <p className="mt-2 text-[11px] italic text-[#6e6154]">{sendStatus}</p>}
        </div>

        <div className="relative flex-1 overflow-hidden rounded-[34px] border border-[#e4d7c6] bg-[#fffdf8] shadow-[0_44px_140px_-70px_rgba(45,31,15,0.85)]">
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
            className={`relative z-[1] h-full w-full ${interactionMode === 'adder' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
          />

          {contextMenu && (
            <div
              className="context-menu fixed z-[100] min-w-[190px] rounded-2xl border border-[#e3d6c4] bg-[#fffaf4] py-2 shadow-[0_24px_80px_-40px_rgba(47,32,16,0.9)]"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              {contextMenu.type === 'background' ? (
                <button
                  onClick={() => addBar(contextMenu.x, contextMenu.y)}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-[#5b4d40] transition-colors hover:bg-[#fff1df]"
                >
                  <Plus size={14} /> Add New Bar
                </button>
              ) : (
                <button
                  onClick={() => {
                    setChordPicker({
                      nodeId: contextMenu.nodeId!,
                      x: contextMenu.x,
                      y: contextMenu.y,
                    });
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-[#5b4d40] transition-colors hover:bg-[#fff1df]"
                >
                  <Plus size={14} /> Add Chord
                </button>
              )}
            </div>
          )}

          {chordPicker && (
            <ChordPickerCard
              apiUrl={CHORD_IDENTIFY_API_URL}
              position={{ x: chordPicker.x, y: chordPicker.y }}
              onPick={(chordName) => addChord(chordPicker.nodeId, chordName)}
              onClose={() => setChordPicker(null)}
            />
          )}

          {(isLoadingOverlap || overlapError || fretboardOverlap) && (
            <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-end">
              <div className="pointer-events-auto w-full max-w-[560px] rounded-[14px] border border-[#dfd3c4] bg-[#fffaf3]/92 p-2 shadow-[0_18px_60px_-44px_rgba(47,32,16,0.82)] backdrop-blur">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-[0.22em] text-[#8a7661]">Voicing Overlap</p>
                  {isLoadingOverlap && <span className="text-[10px] text-[#8a7661]">Loading...</span>}
                </div>
                {overlapError && <p className="mb-1 text-[11px] text-[#8a4f4f]">{overlapError}</p>}
                {fretboardOverlap && <TranslucentFretboard data={fretboardOverlap} className="border-0 bg-transparent p-0 shadow-none" />}
              </div>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-[#e4d7c7] bg-[#fffaf2]/80 px-5 py-1.5 text-[12px] text-[#6f6153] shadow-[0_15px_50px_-35px_rgba(47,32,16,0.65)] backdrop-blur">
          <span>Pan/zoom the canvas, click nodes to stage ghost substitutions, and use Suggest to refresh harmonic territories.</span>
          <span className="uppercase tracking-[0.2em] text-[#8a7661]">
            Depth {treeDepth} • {trees.length} bar{trees.length === 1 ? '' : 's'}
          </span>
        </footer>
      </div>
    </div>
  );
}
