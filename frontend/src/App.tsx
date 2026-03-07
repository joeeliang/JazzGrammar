/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Download, Minus, MousePointer2, Plus, PlusCircle, RefreshCw } from 'lucide-react';
import TranslucentFretboard, { FretboardOverlapData } from './guitar';

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
const HORIZONTAL_STEP = 92;
const LAYER_GAP = 140;
const BAR_GAP = 220;
const MIN_BAR_WIDTH = 280;
const NODE_RADIUS = 6;
const TRANSITION_MS = 550;

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
const PROGRESSION_API_URL = (import.meta.env.VITE_PROGRESSION_API_URL as string | undefined)?.trim() || 'http://localhost:8000/progression';
const SUGGESTIONS_API_URL = (import.meta.env.VITE_SUGGESTIONS_API_URL as string | undefined)?.trim() || 'http://localhost:8000/suggestions';
const OVERLAP_API_URL = (import.meta.env.VITE_OVERLAP_API_URL as string | undefined)?.trim() || 'http://localhost:8000/fretboard-overlap';

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

const shouldShowInlineLabel = (node: d3.HierarchyNode<TreeNode>) =>
  Boolean(node.data.isPreview || !node.parent || (node.children && node.children.length > 0));

const estimateLabelSpan = (label: string, variant: 'node' | 'terminal') =>
  variant === 'terminal' ? Math.max(54, label.length * 10 + 14) : Math.max(38, label.length * 8 + 14);

const getNodeHalfWidth = (node: d3.HierarchyNode<TreeNode>) => {
  const variant = shouldShowInlineLabel(node) ? 'node' : 'terminal';
  return estimateLabelSpan(node.data.label, variant) / 2;
};

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
  const offsetX = !hasManualPlacement && contentWidth < innerWidth ? (innerWidth - contentWidth) / 2 - globalMin : -globalMin;

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

  const [trees, setTrees] = useState<TreeNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedGhostId, setSelectedGhostId] = useState<string | null>(null);
  const [previewOptionIndex, setPreviewOptionIndex] = useState(0);
  const [currentPreviewLabels, setCurrentPreviewLabels] = useState<string[]>([]);
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(false);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('pointer');
  const [chordInput, setChordInput] = useState<{ nodeId: string; x: number; y: number } | null>(null);
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

    const point = svg.createSVGPoint();
    point.x = screenX;
    point.y = screenY;

    const screenMatrix = svg.getScreenCTM();
    if (!screenMatrix) {
      return { x: 0, y: 0 };
    }

    const svgPoint = point.matrixTransform(screenMatrix.inverse());
    const zoomTransform = d3.zoomTransform(svg);
    const [zoomedX, zoomedY] = zoomTransform.invert([svgPoint.x, svgPoint.y]);

    return {
      x: zoomedX - MARGIN.left,
      y: zoomedY - MARGIN.top,
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
    setChordInput(null);
    setSendStatus(null);
  };

  const addBar = (screenX: number, screenY: number) => {
    const { x } = screenToDiagramPoint(screenX, screenY);
    const nextTrees = [...trees];

    nextTrees.push({
      id: `root-${Date.now()}`,
      label: `Bar ${nextTrees.length + 1}`,
      initialX: x,
      initialY: 0,
    });

    setTrees(nextTrees);
    setKeyRegionClouds([]);
    setFretboardOverlap(null);
    setOverlapError(null);
    setContextMenu(null);
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
    setChordInput(null);
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
        throw new Error(`HTTP ${response.status}`);
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
        const key = body.inferred_keys[index];
        if (!key) {
          return;
        }
        const existing = keysByBar.get(entry.barIndex) || [];
        existing.push(key);
        keysByBar.set(entry.barIndex, existing);
      });

      const barKeys = trees.map((_, barIndex) => {
        const keyList = keysByBar.get(barIndex) || [];
        if (keyList.length === 0) {
          return null;
        }
        const counts = new Map<string, number>();
        keyList.forEach((key) => counts.set(key, (counts.get(key) || 0) + 1));
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      });

      const regions: KeyRegionCloud[] = [];
      let currentKey: string | null = null;
      let currentStart = -1;
      let regionIndex = 0;

      barKeys.forEach((barKey, barIndex) => {
        if (!barKey) {
          if (currentKey !== null) {
            regions.push({
              regionIndex,
              startBarIndex: currentStart,
              endBarIndex: barIndex - 1,
              key: currentKey,
            });
            regionIndex += 1;
            currentKey = null;
            currentStart = -1;
          }
          return;
        }

        if (currentKey === null) {
          currentKey = barKey;
          currentStart = barIndex;
          return;
        }

        if (barKey !== currentKey) {
          regions.push({
            regionIndex,
            startBarIndex: currentStart,
            endBarIndex: barIndex - 1,
            key: currentKey,
          });
          regionIndex += 1;
          currentKey = barKey;
          currentStart = barIndex;
        }
      });

      if (currentKey !== null) {
        regions.push({
          regionIndex,
          startBarIndex: currentStart,
          endBarIndex: barKeys.length - 1,
          key: currentKey,
        });
      }

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
    const zoomGroup =
      svg.select<SVGGElement>('g.zoom-group').empty()
        ? svg.append('g').attr('class', 'zoom-group')
        : svg.select<SVGGElement>('g.zoom-group');

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
      .scaleExtent([0.35, 2.5])
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
        setChordInput(null);
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
    cloudEnter.append('text').attr('class', 'scientific-text').attr('font-size', 11).attr('font-style', 'italic');

    const cloudUpdate = cloudEnter.merge(cloudSelection as any);

    cloudUpdate.each(function (region: KeyRegionCloud) {
      const regionRoots = roots.slice(region.startBarIndex, region.endBarIndex + 1);
      if (regionRoots.length === 0) {
        return;
      }

      const minX = d3.min(regionRoots, (root) => root.subtreeMinX) ?? 0;
      const maxX = d3.max(regionRoots, (root) => root.subtreeMaxX) ?? 0;
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

    const bbox = mainGroup
      .selectAll<SVGRectElement, PositionedNode>('rect.tree-bounds')
      .data(showBoundingBoxes ? nodes : [], (node: any) => node.data.id);

    bbox.exit().remove();

    bbox
      .enter()
      .append('rect')
      .attr('class', 'tree-bounds pointer-events-none')
      .attr('rx', 18)
      .attr('fill', 'rgba(194, 153, 97, 0.05)')
      .attr('stroke', 'rgba(169, 124, 61, 0.28)')
      .attr('stroke-dasharray', '5 5')
      .merge(bbox as any)
      .transition(transition)
      .attr('x', (node) => node.subtreeMinX - 18)
      .attr('y', (node) => node.layoutY - 26)
      .attr('width', (node) => Math.max(36, node.subtreeMaxX - node.subtreeMinX + 36))
      .attr('height', (node) => Math.max(48, node.height * LAYER_GAP + 52));

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
      .attr('stroke', (link: PositionedLink) => (link.target.data.isPreview ? '#b37a3c' : '#3f3328'))
      .attr('stroke-width', (link: PositionedLink) => (link.target.data.isPreview ? 1.2 : 1.35))
      .attr('stroke-dasharray', (link: PositionedLink) => (link.target.data.isPreview ? '4 6' : 'none'))
      .transition(transition)
      .attr('opacity', 1)
      .attr('d', (link: PositionedLink) => linkPath(link.source, link.target));

    const terminalLinkSelection = mainGroup
      .selectAll<SVGLineElement, PositionedNode>('line.terminal-link')
      .data(leaves, (leaf: any) => leaf.data.id);

    terminalLinkSelection.exit().transition(transition).attr('opacity', 0).remove();

    const terminalLinkEnter = terminalLinkSelection
      .enter()
      .append('line')
      .attr('class', 'terminal-link pointer-events-none')
      .attr('stroke', '#80654a')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3 5')
      .attr('opacity', 0)
      .attr('x1', (leaf) => getStartingPoint(leaf).x)
      .attr('x2', (leaf) => getStartingPoint(leaf).x)
      .attr('y1', (leaf) => getStartingPoint(leaf).y)
      .attr('y2', (leaf) => getStartingPoint(leaf).y);

    terminalLinkEnter
      .merge(terminalLinkSelection as any)
      .transition(transition)
      .attr('opacity', 1)
      .attr('x1', (leaf: PositionedNode) => leaf.layoutX)
      .attr('x2', (leaf: PositionedNode) => leaf.layoutX)
      .attr('y1', (leaf: PositionedNode) => leaf.layoutY)
      .attr('y2', terminalY);

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

    nodeEnter.append('circle').attr('class', 'node-hit').attr('r', 22).attr('fill', 'transparent');

    nodeEnter
      .append('circle')
      .attr('class', 'node-halo')
      .attr('r', 15)
      .attr('fill', 'rgba(194, 153, 97, 0.18)')
      .attr('opacity', 0);

    nodeEnter.append('circle').attr('class', 'node-dot');

    nodeEnter
      .append('text')
      .attr('class', 'node-label scientific-text')
      .attr('text-anchor', 'middle')
      .attr('pointer-events', 'none');

    const nodeUpdate = nodeEnter.merge(nodeSelection as any);

    nodeUpdate
      .style('cursor', (node: PositionedNode) => {
        if (node.data.isPreview) {
          return 'pointer';
        }

        if (interactionMode === 'adder') {
          return 'cell';
        }

        return node.parent ? 'pointer' : 'default';
      })
      .on('click', (event: any, node: PositionedNode) => {
        event.stopPropagation();
        setContextMenu(null);

        if (interactionMode === 'adder') {
          if (!node.data.isPreview) {
            setChordInput({
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
      .select<SVGCircleElement>('circle.node-halo')
      .transition(transition)
      .attr('opacity', (node: PositionedNode) => (node.data.id === selectedNodeId || node.data.id === selectedGhostId ? 1 : 0));

    nodeUpdate
      .select<SVGCircleElement>('circle.node-dot')
      .attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round')
      .transition(transition)
      .attr('r', (node: PositionedNode) => (!node.parent ? 8.5 : node.data.isPreview ? 6.5 : NODE_RADIUS))
      .attr('fill', (node: PositionedNode) => {
        if (!node.parent) return '#8c5a2b';
        if (node.data.id === selectedGhostId) return '#b87932';
        if (node.data.id === selectedNodeId) return '#f1dec1';
        return node.data.isPreview ? '#fff4e4' : '#fffdfa';
      })
      .attr('stroke', (node: PositionedNode) => {
        if (!node.parent) return '#5c3b1f';
        if (node.data.id === selectedGhostId) return '#7f4f20';
        if (node.data.id === selectedNodeId) return '#9a622c';
        return node.data.isPreview ? '#b37a3c' : '#3f3328';
      })
      .attr('stroke-width', (node: PositionedNode) => (node.data.id === selectedNodeId || node.data.id === selectedGhostId ? 2.2 : 1.4))
      .attr('stroke-dasharray', (node: PositionedNode) => (node.data.isPreview ? '4 4' : 'none'));

    nodeUpdate
      .select<SVGTextElement>('text.node-label')
      .text((node: PositionedNode) => (shouldShowInlineLabel(node) ? node.data.label : ''))
      .transition(transition)
      .attr('opacity', (node: PositionedNode) => (shouldShowInlineLabel(node) ? 1 : 0))
      .attr('dy', (node: PositionedNode) => (!node.parent ? -32 : -18))
      .attr('fill', (node: PositionedNode) => (!node.parent ? '#6f655c' : node.data.isPreview ? '#9a622c' : '#241d18'))
      .attr('font-size', (node: PositionedNode) => (!node.parent ? 12 : 18))
      .attr('font-style', (node: PositionedNode) => (!node.parent ? 'normal' : 'italic'))
      .attr('font-weight', (node: PositionedNode) => (!node.parent ? 600 : 500))
      .attr('letter-spacing', (node: PositionedNode) => (!node.parent ? '0.18em' : '0.02em'));

    const selectedNodes = nodeUpdate.filter(
      (node: PositionedNode) => node.data.id === selectedNodeId || node.data.id === selectedGhostId,
    );
    selectedNodes.raise();

    const terminalLabelSelection = mainGroup
      .selectAll<SVGTextElement, PositionedNode>('text.terminal-label')
      .data(leaves, (leaf: any) => leaf.data.id);

    terminalLabelSelection.exit().transition(transition).attr('opacity', 0).remove();

    const terminalLabelEnter = terminalLabelSelection
      .enter()
      .append('text')
      .attr('class', 'terminal-label scientific-text')
      .attr('text-anchor', 'middle')
      .attr('fill', '#241d18')
      .attr('font-size', 17)
      .attr('font-style', 'italic')
      .attr('opacity', 0)
      .attr('x', (leaf) => getStartingPoint(leaf).x)
      .attr('y', terminalY + 28);

    terminalLabelEnter
      .merge(terminalLabelSelection as any)
      .text((leaf: PositionedNode) => leaf.data.label)
      .transition(transition)
      .attr('opacity', 1)
      .attr('x', (leaf: PositionedNode) => leaf.layoutX)
      .attr('y', terminalY + 30);

    nodePositionRef.current = new Map(
      nodes.map((node) => [
        node.data.id,
        {
          x: node.layoutX,
          y: node.layoutY,
        },
      ]),
    );
  }, [currentPreviewLabels, interactionMode, keyRegionClouds, selectedGhostId, selectedNodeId, showBoundingBoxes, trees]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (contextMenu && !document.querySelector('.context-menu')?.contains(event.target as Node)) {
        setContextMenu(null);
      }

      if (chordInput && !document.querySelector('.chord-input-container')?.contains(event.target as Node)) {
        setChordInput(null);
      }
    };

    window.addEventListener('mousedown', handleMouseDown);

    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [chordInput, contextMenu]);

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
        <div className="rounded-[28px] border border-[#e4d8c8] bg-[#fffaf2]/88 px-5 py-4 shadow-[0_22px_72px_-44px_rgba(49,35,18,0.72)] backdrop-blur">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-[0.3em] text-[#8a7661]">Deterministic Harmonic Grammar</p>
              <h1 className="scientific-text text-4xl leading-none tracking-tight text-[#241d18]">Harmonic Analysis Tree</h1>
            </div>

            <div className="max-w-xl text-right text-[12px] leading-5 text-[#6a5c4f]">
              Tidy-tree spacing with explicit bar packing keeps branches stable while preserving substitutions and key regions.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 border-t border-[#e8dccd] pt-3">
            <div className="mr-2 flex rounded-full border border-[#dacdbd] bg-white/80 p-1 shadow-inner">
              <button
                onClick={() => {
                  setInteractionMode('pointer');
                  setChordInput(null);
                }}
                className={`rounded-full px-3 py-2 transition-colors ${
                  interactionMode === 'pointer' ? 'bg-[#f0dfc5] text-[#5f3d1f]' : 'text-[#8c7a67] hover:text-[#5f3d1f]'
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
                className={`rounded-full px-3 py-2 transition-colors ${
                  interactionMode === 'adder' ? 'bg-[#f0dfc5] text-[#5f3d1f]' : 'text-[#8c7a67] hover:text-[#5f3d1f]'
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

            <div className="ml-auto flex items-center gap-3 rounded-full border border-[#dbcdbb] bg-white/75 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-[#7d6955]">
              <input
                type="checkbox"
                id="bbox-toggle"
                checked={showBoundingBoxes}
                onChange={(event) => setShowBoundingBoxes(event.target.checked)}
                className="h-3.5 w-3.5 cursor-pointer rounded border-[#cdbca7] text-[#8c5a2b] focus:ring-[#c89d67]"
              />
              <label htmlFor="bbox-toggle" className="cursor-pointer select-none">
                Structure Boxes
              </label>
            </div>
          </div>

          {sendStatus && <p className="mt-2 text-[11px] italic text-[#6e6154]">{sendStatus}</p>}
        </div>

        <div className="relative flex-1 overflow-hidden rounded-[34px] border border-[#e4d7c6] bg-[#fffdf8] shadow-[0_44px_140px_-70px_rgba(45,31,15,0.85)]">
          <div
            className="pointer-events-none absolute inset-0 opacity-95"
            style={{
              backgroundImage:
                'radial-gradient(circle at top, rgba(201, 165, 113, 0.17), transparent 30%), linear-gradient(180deg, rgba(255, 254, 251, 0.98), rgba(255, 249, 240, 0.92)), linear-gradient(rgba(183, 165, 134, 0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(183, 165, 134, 0.08) 1px, transparent 1px)',
              backgroundSize: '100% 100%, 100% 100%, 100% 140px, 120px 100%',
            }}
          />

          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-40"
            style={{ background: 'radial-gradient(circle at top, rgba(255, 255, 255, 0.95), transparent 68%)' }}
          />

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
                    setChordInput({
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

          {chordInput && (
            <div
              className="chord-input-container fixed z-[110] rounded-2xl border border-[#e3d6c4] bg-[#fffaf4] p-2 shadow-[0_24px_80px_-40px_rgba(47,32,16,0.9)]"
              style={{ left: chordInput.x, top: chordInput.y }}
            >
              <input
                autoFocus
                type="text"
                placeholder="Chord name..."
                className="w-44 rounded-xl border border-[#eadfce] bg-white px-3 py-2 text-sm text-[#3f3328] outline-none ring-0 placeholder:text-[#9b8873] focus:border-[#cda16a]"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addChord(chordInput.nodeId, (event.target as HTMLInputElement).value);
                  } else if (event.key === 'Escape') {
                    setChordInput(null);
                  }
                }}
              />
            </div>
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

        <footer className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-[#e4d7c7] bg-[#fffaf2]/80 px-5 py-3 text-[13px] text-[#6f6153] shadow-[0_18px_60px_-44px_rgba(47,32,16,0.75)] backdrop-blur">
          <span>Pan/zoom the canvas, click nodes to stage ghost substitutions, and use Suggest to refresh harmonic territories.</span>
          <span className="uppercase tracking-[0.2em] text-[#8a7661]">
            Depth {treeDepth} • {trees.length} bar{trees.length === 1 ? '' : 's'}
          </span>
        </footer>
      </div>
    </div>
  );
}
