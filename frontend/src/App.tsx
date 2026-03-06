/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Plus, Minus, RefreshCw, Download, MousePointer2, PlusCircle, Pencil } from 'lucide-react';

interface TreeNode {
  id: string;
  label: string;
  children?: TreeNode[];
  initialX?: number;
  initialY?: number;
  isPreview?: boolean;
}

const MUSICAL_LABELS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°', 'V⁷', 'ii⁷', 'vi⁷', 'IV⁶', 'I⁶', 'V/V', 'V/IV'];
const CHORD_NAMES = ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim', 'G7', 'Dm7', 'Am7', 'F6', 'Cmaj7', 'Fm', 'Gm7'];

const EXPANSION_OPTIONS: Record<string, string[][]> = {
  'I': [['vi', 'ii', 'V', 'I'], ['IV', 'vii°', 'iii', 'vi'], ['I', 'V', 'vi', 'IV']],
  'V': [['ii', 'V', 'I', 'V'], ['vi', 'IV', 'I', 'V'], ['V/V', 'V', 'ii', 'V']],
  'ii': [['vi', 'ii', 'V/V', 'V'], ['I', 'vi', 'ii', 'V'], ['ii⁷', 'V⁷', 'I', 'ii']],
  'IV': [['I', 'IV', 'V', 'I'], ['ii', 'V', 'I', 'IV'], ['IV⁶', 'V⁷', 'I', 'IV']],
  'vi': [['iii', 'vi', 'ii', 'V'], ['I', 'V', 'vi', 'iii'], ['vi⁷', 'ii⁷', 'V⁷', 'I']],
  'root': [['I', 'IV', 'V', 'I'], ['vi', 'ii', 'V', 'I']],
};

const generateRandomLabel = (isLeaf: boolean) => {
  const list = isLeaf ? CHORD_NAMES : MUSICAL_LABELS;
  return list[Math.floor(Math.random() * list.length)];
};

export default function App() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [trees, setTrees] = useState<TreeNode[]>([
    {
      id: 'root-1',
      label: 'Bar 1',
      children: [
        { id: '1', label: 'I', children: [{ id: '1-1', label: 'Cmaj7' }] },
        { id: '2', label: 'I', children: [{ id: '2-1', label: 'C' }] }
      ]
    }
  ]);
  const [depth, setDepth] = useState(2);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedGhostId, setSelectedGhostId] = useState<string | null>(null);
  const [previewOptionIndex, setPreviewOptionIndex] = useState(0);
  const [currentPreviewLabels, setCurrentPreviewLabels] = useState<string[]>([]);
  const [showBoundingBoxes, setShowBoundingBoxes] = useState(false);
  const [interactionMode, setInteractionMode] = useState<'pointer' | 'adder'>('pointer');
  const [chordInput, setChordInput] = useState<{ nodeId: string, x: number, y: number } | null>(null);
  
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: 'background' | 'root';
    nodeId?: string;
  } | null>(null);

  useEffect(() => {
    if (selectedNodeId) {
      // Find the node in any of the trees
      let target: d3.HierarchyNode<TreeNode> | undefined;
      for (const tree of trees) {
        const root = d3.hierarchy(tree);
        const found = root.descendants().find(d => d.data.id === selectedNodeId);
        if (found) {
          target = found;
          break;
        }
      }
      
      if (target) {
        if (target.parent?.data?.id === 'super-root') {
          setCurrentPreviewLabels([]);
          return;
        }
        const options = getOptions(target.data.label);
        const currentOption = options[previewOptionIndex % options.length];
        if (currentOption) {
          const labels = currentOption[0] === 'Unitary Substitute' 
            ? [generateRandomLabel(true), generateRandomLabel(true), generateRandomLabel(true), generateRandomLabel(true)] 
            : currentOption;
          setCurrentPreviewLabels(labels);
        }
      }
    } else {
      setCurrentPreviewLabels([]);
    }
  }, [selectedNodeId, previewOptionIndex, trees]);

  const handleExpansion = (nodeId: string, expansionLabels: string[]) => {
    const newTrees = JSON.parse(JSON.stringify(trees));
    let idCounter = Date.now();

    const findAndReplace = (node: TreeNode) => {
      if (node.id === nodeId) {
        node.children = expansionLabels.map((label, i) => ({
          id: `${idCounter++}-${i}`,
          label: label,
        }));
        return true;
      }
      if (node.children) {
        for (const child of node.children) {
          if (findAndReplace(child)) return true;
        }
      }
      return false;
    };

    for (const tree of newTrees) {
      if (findAndReplace(tree)) break;
    }
    
    setTrees(newTrees);
    setSelectedNodeId(null);
    setSelectedGhostId(null);

    // Recalculate max depth across all trees
    const getDepth = (n: TreeNode): number => {
      if (!n.children || n.children.length === 0) return 1;
      return 1 + Math.max(...n.children.map(getDepth));
    };
    const maxDepth = Math.max(...newTrees.map(getDepth));
    setDepth(maxDepth);
  };

  const addLayer = () => {
    const newTrees = JSON.parse(JSON.stringify(trees));
    let idCounter = Date.now();

    const transformLeaves = (node: TreeNode) => {
      if (!node.children || node.children.length === 0) {
        const numChildren = Math.random() > 0.3 ? 2 : 1;
        // Current leaf becomes an internal node, so give it a musical label
        node.label = generateRandomLabel(false);
        node.children = Array.from({ length: numChildren }, (_, i) => ({
          id: `${idCounter++}-${i}`,
          label: generateRandomLabel(true) // New children are leaves/terminal
        }));
      } else {
        node.children.forEach(child => transformLeaves(child));
      }
    };

    newTrees.forEach((tree: TreeNode) => transformLeaves(tree));
    setTrees(newTrees);
    setDepth(prev => prev + 1);
  };

  const removeLayer = () => {
    if (depth <= 1) return;
    const newTrees = JSON.parse(JSON.stringify(trees));

    const removeDeepest = (node: TreeNode): boolean => {
      if (!node.children) return false;
      
      // Check if children are leaves
      const allChildrenAreLeaves = node.children.every(child => !child.children || child.children.length === 0);
      
      if (allChildrenAreLeaves) {
        delete node.children;
        return true;
      } else {
        node.children.forEach(child => removeDeepest(child));
        return false;
      }
    };

    newTrees.forEach((tree: TreeNode) => removeDeepest(tree));
    setTrees(newTrees);
    setDepth(prev => prev - 1);
  };

  const resetTree = () => {
    setTrees([
      {
        id: 'root-1',
        label: 'Bar 1',
        children: [
          { id: '1', label: 'I', children: [{ id: '1-1', label: 'Cmaj7' }] },
          { id: '2', label: 'I', children: [{ id: '2-1', label: 'C' }] }
        ]
      }
    ]);
    setDepth(2);
    setSelectedNodeId(null);
    setSelectedGhostId(null);
  };

  const addBar = (screenX: number, screenY: number) => {
    if (!svgRef.current) return;
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = screenX;
    pt.y = screenY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    // Adjust for main-group transform (margin.left, margin.top)
    const initialX = svgP.x - 100; // margin.left is 100
    
    const newBar: TreeNode & { initialX?: number; initialY?: number } = {
      id: `root-${Date.now()}`,
      label: `Bar ${trees.length + 1}`,
      initialX: initialX,
      initialY: 0
    };
    setTrees([...trees, newBar]);
    setContextMenu(null);
  };

  const addChord = (nodeId: string, chordLabel: string) => {
    if (!chordLabel) return;

    const newTrees = JSON.parse(JSON.stringify(trees));
    const findAndAdd = (node: TreeNode) => {
      if (node.id === nodeId) {
        const newChord: TreeNode = {
          id: `chord-${Date.now()}`,
          label: chordLabel
        };
        node.children = node.children ? [...node.children, newChord] : [newChord];
        return true;
      }
      if (node.children) {
        for (const child of node.children) {
          if (findAndAdd(child)) return true;
        }
      }
      return false;
    };

    for (const tree of newTrees) {
      if (findAndAdd(tree)) break;
    }
    setTrees(newTrees);
    setContextMenu(null);
    setChordInput(null);
  };

  const simulationRef = useRef<d3.Simulation<any, undefined> | null>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const width = 1600; // Increased width for more spread
    const height = 800; // Increased height
    const margin = { top: 80, right: 100, bottom: 100, left: 100 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        zoomGroup.attr('transform', event.transform);
      });

    // Zoom setup
    let zoomGroup = svg.select<SVGGElement>('g.zoom-group');
    if (zoomGroup.empty()) {
      zoomGroup = svg.append('g').attr('class', 'zoom-group');
      
      // Initial zoom state
      svg.call(zoom.transform, d3.zoomIdentity);
    }

    svg.call(zoom)
      .on("dblclick.zoom", null) // Disable double-click zoom
      .on('click', (event) => {
        // Only clear selection if clicking directly on the SVG background
        // and NOT if the click was suppressed by a zoom/pan action
        if (event.target === svg.node() && !event.defaultPrevented) {
          if (interactionMode === 'adder') {
            addBar(event.clientX, event.clientY);
          } else {
            setSelectedNodeId(null);
            setSelectedGhostId(null);
            setContextMenu(null);
            setChordInput(null);
          }
        }
      })
      .on('contextmenu', (event) => {
        event.preventDefault();
        // Get coordinates relative to the SVG, but we'll use screen coordinates for the React menu
        // to avoid zoom/pan transformation issues on the menu itself
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          type: 'background'
        });
      });

    let g = zoomGroup.select<SVGGElement>('g.main-group');
    if (g.empty()) {
      g = zoomGroup.append('g').attr('class', 'main-group').attr('transform', `translate(${margin.left},${margin.top})`);
    }

    // Clone data to inject previews without mutating state
    const displayTrees = JSON.parse(JSON.stringify(trees));
    if (selectedNodeId && currentPreviewLabels.length > 0) {
      const injectGhosts = (node: any) => {
        if (node.id === selectedNodeId) {
          const ghosts = currentPreviewLabels.map((l: string, i: number) => ({
            id: `ghost-${selectedNodeId}-${i}`,
            label: l,
            isPreview: true,
            optionLabels: currentPreviewLabels
          }));
          node.children = node.children ? [...node.children, ...ghosts] : ghosts;
          return true;
        }
        if (node.children) {
          for (const child of node.children) {
            if (injectGhosts(child)) return true;
          }
        }
        return false;
      };
      displayTrees.forEach((tree: any) => injectGhosts(tree));
    }

    // Create a dummy super-root to use d3.hierarchy and tree layout on multiple trees
    const superRootData: TreeNode = { id: 'super-root', label: '', children: displayTrees };
    const root = d3.hierarchy(superRootData);
    
    // We don't actually use treeLayout for positioning anymore, we use force simulation
    // but we still need the hierarchy to get links and descendants
    const newNodes = root.descendants();
    const newLinks = root.links();
    const visibleNodes = newNodes.filter(d => d.data.id !== 'super-root');
    const visibleLinks = newLinks.filter(
      (l: any) => l.source.data.id !== 'super-root' && l.target.data.id !== 'super-root'
    );

    // If simulation doesn't exist, create it
    if (!simulationRef.current) {
      simulationRef.current = d3.forceSimulation<any>()
        .force('link', d3.forceLink<any, any>().id(d => d.data.id).distance(40).strength(0.5))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('x', d3.forceX<any>(innerWidth / 2).strength(0.01)) // Weak pull to center
        .force('collision', d3.forceCollide().radius(35))
        .velocityDecay(0.5);
    }

    const simulation = simulationRef.current;
    const oldNodes = simulation.nodes();
    const nodeMap = new Map(oldNodes.map(d => [d.data.id, d]));

    // Sync nodes: preserve existing positions, initialize new ones at parent
    newNodes.forEach((d: any) => {
      const old = nodeMap.get(d.data.id) as any;
      if (old) {
        d.x = old.x;
        d.y = old.y;
        d.vx = old.vx;
        d.vy = old.vy;
      } else {
        // New node: spawn slightly below parent with deterministic X offset to prevent crossing
        if (d.parent && d.parent.data.id !== 'super-root') {
          const parentInSim = nodeMap.get(d.parent.data.id) || d.parent;
          const siblings = d.parent.children || [];
          const index = siblings.indexOf(d);
          const spread = 15; // Initial spread to avoid overlap
          const xOffset = (index - (siblings.length - 1) / 2) * spread;
          
          d.x = (parentInSim.x || innerWidth / 2) + xOffset;
          d.y = (parentInSim.y || 0) + 10;
          
          // Initial "catapult" velocity in the correct direction
          d.vx = xOffset * 1.5;
          d.vy = 15;
        } else {
          // New root node: spawn at current mouse position if available, or center
          d.x = d.data.initialX || innerWidth / 2;
          d.y = d.data.initialY || 0;
        }
      }

      // Anchor the root nodes to prevent drifting if they were manually placed
      // but the user wants them to be at the same layer (y=0)
      if (d.parent && d.parent.data.id === 'super-root') {
        d.fy = 0;
        // We don't fix fx so they can balance horizontally
      }
    });

    simulation.nodes(newNodes);
    (simulation.force('link') as d3.ForceLink<any, any>).links(newLinks);
    
    // Add a Y force that pulls to the layer level (Constant gap)
    const LAYER_GAP = 120;
    const maxDepth = d3.max(newNodes, d => d.depth - 1) || 0;
    const terminalY = (maxDepth + 1) * LAYER_GAP;

    simulation.force('y', d3.forceY<any>((d: any) => {
      if (d.data.id === selectedGhostId) return terminalY;
      return (d.depth - 1) * LAYER_GAP;
    }).strength(0.12));
    
    // Add a centering force to pull everything toward the middle
    simulation.force('x', d3.forceX<any>(innerWidth / 2).strength(0.01));
    
    simulation.alpha(1).restart();

    // Render Links
    const link = g.selectAll<SVGPathElement, any>('.link')
      .data(visibleLinks, (d: any) => `${d.source.data.id}-${d.target.data.id}`);

    link.exit().remove();

    const linkEnter = link.enter()
      .append('path')
      .attr('class', 'link pointer-events-none')
      .attr('fill', 'none')
      .attr('stroke', (d: any) => d.target.data.isPreview ? '#334155' : '#1a1a1a')
      .attr('stroke-width', 0.6)
      .attr('stroke-dasharray', (d: any) => d.target.data.isPreview ? '2,2' : 'none')
      .attr('opacity', 0);

    const linkUpdate = linkEnter.merge(link);
    linkUpdate
      .attr('stroke', (d: any) => d.target.data.isPreview ? '#334155' : '#1a1a1a')
      .attr('stroke-dasharray', (d: any) => d.target.data.isPreview ? '2,2' : 'none')
      .transition().duration(800)
      .attr('opacity', 1);

    // Render Terminal Links
    const leaves = root.leaves().filter(d => !d.data.isPreview);
    const terminalLink = g.selectAll<SVGLineElement, any>('.terminal-link')
      .data(leaves, (d: any) => d.data.id);

    terminalLink.exit().remove();

    const terminalLinkEnter = terminalLink.enter()
      .append('line')
      .attr('class', 'terminal-link pointer-events-none')
      .attr('stroke', '#1a1a1a')
      .attr('stroke-width', 0.6)
      .attr('stroke-dasharray', '2,2')
      .attr('opacity', 0);

    const terminalLinkUpdate = terminalLinkEnter.merge(terminalLink);
    terminalLinkUpdate.transition().duration(800).attr('opacity', 1);

    // Render Nodes
    const node = g.selectAll<SVGGElement, any>('.node')
      .data(visibleNodes, (d: any) => d.data.id);

    node.exit().remove();

    const nodeEnter = node.enter()
      .append('g')
      .attr('class', 'node cursor-pointer')
      .call(d3.drag<any, any>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any);

    // Add a transparent hit area for easier clicking
    nodeEnter.append('circle')
      .attr('r', 15)
      .attr('fill', 'transparent')
      .attr('class', 'hit-area');

    nodeEnter.append('circle')
      .attr('r', 5);

    nodeEnter.append('text')
      .attr('dy', '-1em')
      .attr('text-anchor', 'middle')
      .attr('class', 'scientific-text text-sm italic font-serif select-none pointer-events-none')
      .attr('opacity', 0);

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.on('click', (event, d) => {
      event.stopPropagation();
      setContextMenu(null);

      if (interactionMode === 'pointer' && d.parent?.data?.id === 'super-root') {
        return;
      }

      if (interactionMode === 'adder') {
        if (!d.data.isPreview) {
          setChordInput({
            nodeId: d.data.id,
            x: event.clientX,
            y: event.clientY
          });
        }
        return;
      }

      if (d.data.isPreview) {
        if (selectedGhostId === d.data.id) {
          // Confirm ONLY the staged ghost node
          handleExpansion(selectedNodeId!, [d.data.label]);
        } else {
          setSelectedGhostId(d.data.id);
        }
      } else {
        setSelectedNodeId(d.data.id);
        setSelectedGhostId(null);
        setPreviewOptionIndex(0);
      }
    })
    .on('contextmenu', (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      if (!d.parent || d.parent.data.id === 'super-root') {
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          type: 'root',
          nodeId: d.data.id
        });
      }
    });
    
    // Bounding Box Visualization
    const bbox = nodeUpdate.selectAll<SVGRectElement, any>('.bbox')
      .data(d => showBoundingBoxes ? [d] : []);
    
    bbox.exit().remove();
    bbox.enter().append('rect')
      .attr('class', 'bbox')
      .attr('fill', 'rgba(59, 130, 246, 0.02)')
      .attr('stroke', 'rgba(59, 130, 246, 0.2)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,4')
      .merge(bbox as any);

    const sBbox = nodeUpdate.selectAll<SVGRectElement, any>('.s-bbox')
      .data((d: any) => (showBoundingBoxes && d.sMin !== d.minX) ? [d] : []);
    
    sBbox.exit().remove();
    sBbox.enter().append('rect')
      .attr('class', 's-bbox')
      .attr('fill', 'none')
      .attr('stroke', 'rgba(16, 185, 129, 0.3)') // Emerald for structural
      .attr('stroke-width', 1)
      .merge(sBbox as any);

    nodeUpdate.select('circle')
      .attr('fill', (d: any) => {
        if (d.data.id === selectedGhostId) return '#334155';
        return d.data.isPreview ? '#f1f5f9' : '#fff';
      })
      .attr('stroke', (d: any) => {
        if (d.data.id === selectedGhostId) return '#0f172a';
        return d.data.isPreview ? '#334155' : '#1a1a1a';
      })
      .attr('stroke-width', (d: any) => d.data.id === selectedGhostId ? 2 : 1.5)
      .attr('stroke-dasharray', (d: any) => (d.data.isPreview && d.data.id !== selectedGhostId) ? '2,2' : 'none');

    nodeUpdate.select('text')
      .attr('fill', (d: any) => {
        if (d.data.id === selectedGhostId) return '#0f172a';
        return d.data.isPreview ? '#334155' : '#1a1a1a';
      })
      .text(d => d.data.label)
      .transition().duration(800)
      .attr('opacity', 1);

    // Terminal labels
    const terminalLabel = g.selectAll<SVGTextElement, any>('.terminal-label')
      .data(leaves, (d: any) => d.data.id);

    terminalLabel.exit().remove();

    const terminalLabelEnter = terminalLabel.enter()
      .append('text')
      .attr('class', 'terminal-label scientific-text text-sm font-serif select-none pointer-events-none')
      .attr('text-anchor', 'middle')
      .text(d => d.data.label)
      .attr('opacity', 0);

    const terminalLabelUpdate = terminalLabelEnter.merge(terminalLabel);
    terminalLabelUpdate.transition().duration(800).attr('opacity', 1);

    simulation.on('tick', () => {
      // 1. Calculate subtree extents
      const updateExtents = (node: any) => {
        let x = node.x || 0;
        
        // Structural extents (real nodes + staged ghosts)
        let sMin = x;
        let sMax = x;

        if (node.children && node.children.length > 0) {
          node.children.forEach((child: any) => {
            updateExtents(child);
            
            const isSolid = !child.data.isPreview || child.data.id === selectedGhostId;
            if (isSolid) {
              sMin = Math.min(sMin, child.sMin);
              sMax = Math.max(sMax, child.sMax);
            }
          });
        }
        
        node.sMin = sMin;
        node.sMax = sMax;
        
        // For physics, we use sMin/sMax for solid nodes. 
        // BUT we want siblings to stay away from the ghost cluster.
        const ghostRadius = 90; // Even more freedom
        const hasGhosts = node.children?.some((c: any) => c.data.isPreview && c.data.id !== selectedGhostId);
        
        node.minX = (!node.data.isPreview || node.data.id === selectedGhostId) 
          ? Math.min(sMin, hasGhosts ? x - ghostRadius : sMin) 
          : x - 5;
        node.maxX = (!node.data.isPreview || node.data.id === selectedGhostId) 
          ? Math.max(sMax, hasGhosts ? x + ghostRadius : sMax) 
          : x + 5;
      };
      updateExtents(root);

      // 2. Physics: Sibling Subtree Separation & Parent Centering
      root.descendants().forEach((d: any) => {
        // A. Separate siblings
        if (d.children && d.children.length > 1) {
          for (let i = 0; i < d.children.length - 1; i++) {
            const left = d.children[i];
            const right = d.children[i + 1];
            
            const leftIsSolid = !left.data.isPreview || left.data.id === selectedGhostId;
            const rightIsSolid = !right.data.isPreview || right.data.id === selectedGhostId;
            
            if (leftIsSolid && rightIsSolid) {
              // Solid vs Solid: Full subtree separation
              const minGap = 120; // More space between branches
              if (left.maxX + minGap > right.minX) {
                const overlap = (left.maxX + minGap - right.minX);
                const strength = 0.3; // Stronger push
                const leftDesc = left.descendants();
                const rightDesc = right.descendants();
                leftDesc.forEach((n: any) => n.vx -= overlap * strength);
                rightDesc.forEach((n: any) => n.vx += overlap * strength);
              }
            } else if (!leftIsSolid && !rightIsSolid) {
              // Ghost vs Ghost: Tight individual separation
              const minGap = 35;
              if (left.x + minGap > right.x) {
                const overlap = (left.x + minGap - right.x);
                left.vx -= overlap * 0.1;
                right.vx += overlap * 0.1;
              }
            }
            // Ghost vs Solid: NO INTERACTION (Ghosts are weightless)
          }
        }

        // B. Balancing: Center subtrees under parent
        if (d.children && d.children.length > 0) {
          const solidChildren = d.children.filter((c: any) => !c.data.isPreview || c.data.id === selectedGhostId);
          const hasSolid = solidChildren.length > 0;
          
          if (hasSolid) {
            const cMin = Math.min(...solidChildren.map((c: any) => c.sMin));
            const cMax = Math.max(...solidChildren.map((c: any) => c.sMax));
            const cMid = (cMin + cMax) / 2;
            
            // Pull parent toward the midpoint of its solid children's subtrees
            if (d.parent) {
              d.vx += (cMid - d.x) * 0.15;
            }
            
            // Pull solid children to be centered under parent
            const offset = d.x - cMid;
            solidChildren.forEach((c: any) => {
              const desc = c.descendants();
              // Stronger pull for verticality
              desc.forEach((n: any) => n.vx += offset * 0.15);
            });
          }
          
          // Non-staged ghosts: Radial distribution around parent
          const ghosts = d.children.filter((c: any) => c.data.isPreview && c.data.id !== selectedGhostId);
          if (ghosts.length > 0) {
            const radius = 60;
            const angleRange = Math.PI * 0.7; // ~126 degree arc
            ghosts.forEach((c: any, i: number) => {
              const angle = (i - (ghosts.length - 1) / 2) * (angleRange / Math.max(1, ghosts.length - 1));
              const tx = d.x + radius * Math.sin(angle);
              const ty = d.y + radius * Math.cos(angle);
              
              c.vx += (tx - c.x) * 0.25;
              // Store targetY for the tick function
              c.targetGhostY = ty;
            });
          }
        }
      });

      // 4. Render Updates & Strict Y enforcement
      const LAYER_GAP = 120;
      const maxDepth = d3.max(newNodes, d => d.depth) || 0;
      const terminalY = (maxDepth + 1) * LAYER_GAP;
      
      linkUpdate.attr('d', (d: any) => `M${d.source.x},${d.source.y} L${d.target.x},${d.target.y}`);
      
      nodeUpdate.attr('transform', (d: any) => {
        const targetY = (d.data.id === selectedGhostId) ? terminalY : d.depth * LAYER_GAP;
        
        // Update bounding box if visible
        if (showBoundingBoxes) {
          const fullWidth = (d.maxX || d.x) - (d.minX || d.x);
          const fullXOffset = (d.minX || d.x) - d.x;
          
          const sWidth = (d.sMax || d.x) - (d.sMin || d.x);
          const sXOffset = (d.sMin || d.x) - d.x;

          const currentNode = nodeUpdate.filter((node: any) => node.data.id === d.data.id);
          
          currentNode.select('.bbox')
            .attr('x', fullXOffset - 10)
            .attr('y', -20)
            .attr('width', Math.max(20, fullWidth + 20))
            .attr('height', 40);

          currentNode.select('.s-bbox')
            .attr('x', sXOffset - 5)
            .attr('y', -15)
            .attr('width', Math.max(10, sWidth + 10))
            .attr('height', 30);
        }

        // Enforce strict Y level unless being dragged or is a non-selected ghost node
        if (d.fx === null || d.fx === undefined) {
          if (d.data.isPreview && d.data.id !== selectedGhostId) {
            // Ghost nodes follow their radial target Y
            const idealY = d.targetGhostY || (d.parent ? d.parent.y + 45 : 0);
            d.y += (idealY - d.y) * 0.15; 
          } else {
            // Real nodes or "staged" ghost nodes use strict Y level
            // If it's the selected ghost, use terminalY
            const finalY = (d.data.id === selectedGhostId) ? terminalY : targetY;
            d.y = finalY;
            d.vy = 0;
          }
        }
        
        return `translate(${d.x},${d.y})`;
      });

      terminalLinkUpdate
        .attr('x1', (d: any) => d.x)
        .attr('y1', (d: any) => d.y)
        .attr('x2', (d: any) => d.x)
        .attr('y2', terminalY);

      terminalLabelUpdate
        .attr('x', (d: any) => d.x)
        .attr('y', terminalY + 25);
    });

    function dragstarted(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event: any, d: any) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event: any, d: any) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    return () => {
      simulation.on('tick', null);
    };
  }, [trees, depth, selectedNodeId, selectedGhostId, previewOptionIndex, currentPreviewLabels, showBoundingBoxes, interactionMode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedNodeId) return;

      if (e.key === 'Tab' || e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        setPreviewOptionIndex(prev => prev + 1);
        setSelectedGhostId(null);
      } else if (e.key === 'Escape') {
        setSelectedNodeId(null);
        setSelectedGhostId(null);
        setContextMenu(null);
      } else if (e.key === 'Enter') {
        if (selectedGhostId) {
          const ghostNode = currentPreviewLabels.find((_, i) => `ghost-${selectedNodeId}-${i}` === selectedGhostId);
          if (ghostNode) {
            handleExpansion(selectedNodeId, [ghostNode]);
          }
        }
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenu && !document.querySelector('.context-menu')?.contains(e.target as Node)) {
        setContextMenu(null);
      }
      if (chordInput && !document.querySelector('.chord-input-container')?.contains(e.target as Node)) {
        setChordInput(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousedown', handleMouseDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [selectedNodeId, previewOptionIndex, trees, currentPreviewLabels, contextMenu, chordInput]);

  const getOptions = (label: string) => {
    const baseLabel = label.split('_')[0];
    return EXPANSION_OPTIONS[baseLabel] || [['Unitary Substitute']];
  };

  return (
    <div className="h-[100dvh] bg-[#fcfcfc] flex flex-col items-center px-4 py-3 overflow-hidden">
      <header className="mb-3 text-center">
        <h1 className="text-3xl font-serif italic mb-1 tracking-tight">Harmonic Analysis Tree</h1>
        <p className="text-zinc-500 font-serif text-xs uppercase tracking-[0.25em]">Generative Structural Representation</p>
      </header>

      <div className="flex gap-3 mb-3 items-center">
        <div className="flex bg-white border border-zinc-200 rounded-full p-0.5 shadow-sm mr-2">
          <button
            onClick={() => {
              setInteractionMode('pointer');
              setChordInput(null);
            }}
            className={`p-2 rounded-full transition-all ${interactionMode === 'pointer' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-600'}`}
            title="Pointer Mode (Select & Expand)"
          >
            <MousePointer2 size={16} />
          </button>
          <button
            onClick={() => {
              setInteractionMode('adder');
              setSelectedNodeId(null);
              setSelectedGhostId(null);
            }}
            className={`p-2 rounded-full transition-all ${interactionMode === 'adder' ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-600'}`}
            title="Adder Mode (Add Bars & Chords)"
          >
            <PlusCircle size={16} />
          </button>
        </div>

        <button
          onClick={addLayer}
          className="flex items-center gap-2 px-3 py-1.5 bg-white border border-zinc-200 rounded-full hover:bg-zinc-50 transition-colors text-xs font-serif italic shadow-sm"
        >
          <Plus size={14} /> Add Layer
        </button>
        <button
          onClick={removeLayer}
          className="flex items-center gap-2 px-3 py-1.5 bg-white border border-zinc-200 rounded-full hover:bg-zinc-50 transition-colors text-xs font-serif italic shadow-sm"
        >
          <Minus size={14} /> Remove Layer
        </button>
        <button
          onClick={resetTree}
          className="flex items-center gap-2 px-3 py-1.5 bg-white border border-zinc-200 rounded-full hover:bg-zinc-50 transition-colors text-xs font-serif italic shadow-sm"
        >
          <RefreshCw size={14} /> Reset
        </button>
      </div>

      <div className="w-full max-w-none flex-1 min-h-0 bg-white border border-zinc-100 rounded-3xl shadow-2xl overflow-hidden relative">
        <div className="absolute top-6 left-6 flex items-center gap-3 z-10 bg-white/50 backdrop-blur-sm p-2 rounded-lg border border-white/20">
          <input 
            type="checkbox" 
            id="bbox-toggle" 
            checked={showBoundingBoxes} 
            onChange={(e) => setShowBoundingBoxes(e.target.checked)}
            className="w-4 h-4 rounded border-zinc-300 text-slate-600 focus:ring-slate-500 cursor-pointer"
          />
          <label htmlFor="bbox-toggle" className="text-[10px] font-serif uppercase tracking-widest text-zinc-400 cursor-pointer select-none">
            Show Bounding Boxes
          </label>
        </div>

        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox="0 0 1600 900"
          className={`w-full h-full ${interactionMode === 'adder' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
        />

        {contextMenu && (
          <div
            className="fixed z-[100] bg-white border border-zinc-200 rounded-xl shadow-2xl py-2 min-w-[180px] animate-in fade-in zoom-in-95 duration-100 context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.type === 'background' ? (
              <button
                onClick={() => addBar(contextMenu.x, contextMenu.y)}
                className="w-full text-left px-4 py-2 hover:bg-zinc-50 text-sm font-serif italic flex items-center gap-2 text-zinc-700"
              >
                <Plus size={14} /> Add New Bar
              </button>
            ) : (
              <button
                onClick={() => {
                  setChordInput({
                    nodeId: contextMenu.nodeId!,
                    x: contextMenu.x,
                    y: contextMenu.y
                  });
                  setContextMenu(null);
                }}
                className="w-full text-left px-4 py-2 hover:bg-zinc-50 text-sm font-serif italic flex items-center gap-2 text-zinc-700"
              >
                <Plus size={14} /> Add Chord
              </button>
            )}
          </div>
        )}

        {chordInput && (
          <div
            className="fixed z-[110] bg-white border border-zinc-200 rounded-xl shadow-2xl p-2 animate-in fade-in zoom-in-95 duration-100 chord-input-container"
            style={{ left: chordInput.x, top: chordInput.y }}
          >
            <input
              autoFocus
              type="text"
              placeholder="Chord name..."
              className="px-3 py-1.5 text-sm font-serif italic border border-zinc-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-200 w-40"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  addChord(chordInput.nodeId, (e.target as HTMLInputElement).value);
                } else if (e.key === 'Escape') {
                  setChordInput(null);
                }
              }}
            />
          </div>
        )}

        {selectedNodeId && (
          <div className="absolute top-6 right-6 bg-white/80 backdrop-blur border border-zinc-200 rounded-xl p-4 shadow-xl animate-in fade-in slide-in-from-top-2">
            <p className="text-[10px] font-serif uppercase tracking-widest text-zinc-400 mb-3">Keyboard Controls</p>
            <div className="flex flex-col gap-2 text-[11px] font-serif italic text-zinc-600">
              <div className="flex justify-between gap-6"><span>Cycle Options</span> <span className="font-sans not-italic font-bold text-zinc-400">TAB / SPACE</span></div>
              <div className="flex justify-between gap-6"><span>Stage Ghost</span> <span className="font-sans not-italic font-bold text-zinc-400">CLICK GHOST</span></div>
              <div className="flex justify-between gap-6"><span>Confirm Staged</span> <span className="font-sans not-italic font-bold text-zinc-400">CLICK AGAIN / ENTER</span></div>
              <div className="flex justify-between gap-6"><span>Cancel</span> <span className="font-sans not-italic font-bold text-zinc-400">ESC</span></div>
            </div>
          </div>
        )}
      </div>

      <footer className="mt-3 text-zinc-400 font-serif text-xs italic">
        Tip: Drag nodes to reposition. Use the pointer tool to expand chords or the adder tool to add bars and chords.
      </footer>
    </div>
  );
}
