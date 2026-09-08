'use client';

import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { RotateCcw, Users, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { APP_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Link } from '@/atoms/Link/Link';
import { Spinner } from '@/atoms/Spinner/Spinner';
import { Tag } from '@/atoms/Tag/Tag';
import { Typography } from '@/atoms/Typography/Typography';
import { GRAPH_PILL_CLASS, GRAPH_SURFACE_CLASS } from '@/config/theme';
import { useFullscreenToggle } from '@/hooks/useFullscreenToggle/useFullscreenToggle';
import { useGraphDebug } from '@/hooks/useGraphDebug/useGraphDebug';
import { useIsMobile } from '@/hooks/useIsMobile/useIsMobile';
import { useSocialGraph } from '@/hooks/useSocialGraph/useSocialGraph';
import type { GraphExpandSource, HideableClass, TrailEntry } from '@/hooks/useSocialGraph/useSocialGraph.types';
import { edgeKey, type SocialGraphVisualEdge, socialProof } from '@/hooks/useSocialGraph/useSocialGraph.utils';
import { useTrackedPoint } from '@/hooks/useTrackedPoint/useTrackedPoint';
import { pulseEvent, pulseStep } from '@/libs/observability/pulse';
import {
  EXPLORER_SURFACE,
  GRAPH_EVENTS,
  GRAPH_FUNNEL_STEPS,
  pulseGraphControl,
} from '@/libs/observability/pulse.graph';
import { cn } from '@/libs/utils/utils';
import type { Pubky } from '@/models/models.types';
import { CanvasAnchoredPopover } from '@/molecules/CanvasAnchoredPopover/CanvasAnchoredPopover';
import { GraphBreadcrumbs } from '@/molecules/GraphBreadcrumbs/GraphBreadcrumbs';
import { GraphSearch } from '@/molecules/GraphSearch/GraphSearch';
import { GraphTimeMachine } from '@/molecules/GraphTimeMachine/GraphTimeMachine';
import { SocialGraphAdvancedPanel } from '@/molecules/SocialGraphAdvancedPanel/SocialGraphAdvancedPanel';
import { SocialGraphControls } from '@/molecules/SocialGraphControls/SocialGraphControls';
import { type EdgeLegendKind, SocialGraphLegend } from '@/molecules/SocialGraphLegend/SocialGraphLegend';
import { GraphUserHoverCard } from '@/organisms/GraphUserHoverCard/GraphUserHoverCard';
import { SocialGraph } from '@/organisms/SocialGraph/SocialGraph';
import type { SocialGraphHandle } from '@/organisms/SocialGraph/SocialGraph.types';
import { SocialGraphNodePanel } from '@/organisms/SocialGraphNodePanel/SocialGraphNodePanel';
import type { NexusGraphNode, NexusGraphUserNode } from '@/services/nexus/graph/graph.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useGraphStore } from '@/stores/graph/graph.store';

type TagEdgePopover = { labels: string[]; sourceId: string; targetId: string; x: number; y: number };
type HoverCard = { node: NexusGraphUserNode; x: number; y: number };

/** Fire a funnel step at most once per mount; a re-fired step blurs the drop-off it measures. */
function fireOnce(fired: MutableRefObject<boolean>, step: string): void {
  if (fired.current) return;
  fired.current = true;
  pulseStep(step);
}

const recordControl = (control: string, state?: 'on' | 'off') => pulseGraphControl(EXPLORER_SURFACE, control, state);

function recordSearchPick(kind: 'user' | 'tag', origin: 'header' | 'inline'): void {
  pulseEvent(GRAPH_EVENTS.SEARCH_PICK, { surface: EXPLORER_SURFACE, kind, origin });
}

function markInteracted(interacted: MutableRefObject<boolean>): void {
  fireOnce(interacted, GRAPH_FUNNEL_STEPS.INTERACTED);
}

/**
 * Graph
 *
 * The graph explorer page: a full-bleed force-directed canvas of the social
 * graph around a user (`?user=<pubky>` deep link, else the signed-in user),
 * with an interactive legend, breadcrumb trail, search-to-add, time machine,
 * declutter and community lenses, and a kind-aware inspector panel.
 */
export function Graph() {
  const t = useTranslations('graph');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const { currentUserPubky } = useAuthStore();
  const centerPubky = (searchParams.get('user') as Pubky | null) ?? currentUserPubky;
  const graph = useSocialGraph();
  const canvasRef = useRef<SocialGraphHandle>(null);
  const { isFullscreen, toggleFullscreen } = useFullscreenToggle(() => canvasRef.current?.fit());
  // The positioned container overlays anchor against; canvas screen
  // coordinates are relative to it
  const pageRef = useRef<HTMLDivElement>(null);
  const [spotlight, setSpotlight] = useState<Set<string> | null>(null);
  const [edgeSpotlight, setEdgeSpotlight] = useState<Set<string> | null>(null);
  const [physicsPaused, setPhysicsPaused] = useState(false);
  const [timeMachineOn, setTimeMachineOn] = useState(false);
  const [tagPopover, setTagPopover] = useState<TagEdgePopover | null>(null);
  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMobile = useIsMobile();
  const { load } = graph;

  // QA/debug surface for the cypress interaction audit (debug builds only)
  const { focusId: graphFocusId, pathIds: graphPathIds } = graph;
  useGraphDebug(canvasRef, {
    focusId: useCallback(() => graphFocusId, [graphFocusId]),
    pathIds: useCallback(() => graphPathIds, [graphPathIds]),
  });

  useEffect(() => {
    if (centerPubky) load(centerPubky);
  }, [centerPubky, load]);

  const openedStep = useRef(false);
  const interactedStep = useRef(false);
  const tracedStep = useRef(false);

  useEffect(() => {
    if (openedStep.current) return;
    openedStep.current = true;
    // No screen call: `PulseInit` already reports '/graph' app-wide
    pulseEvent(GRAPH_EVENTS.OPENED, {
      surface: EXPLORER_SURFACE,
      entry: searchParams.get('user') ? 'deeplink' : currentUserPubky ? 'self' : 'anonymous',
      is_mobile: String(isMobile),
    });
    pulseStep(GRAPH_FUNNEL_STEPS.OPENED);
  }, [searchParams, currentUserPubky, isMobile]);

  useEffect(() => {
    if (!graph.pathIds || graph.pathIds.length === 0) return;
    // A hover-card trace can skip step 3 entirely, which would make its drop-off meaningless
    markInteracted(interactedStep);
    fireOnce(tracedStep, GRAPH_FUNNEL_STEPS.TRACED);
  }, [graph.pathIds]);

  // A search pick focuses, expands, and flies the camera onto the node. The
  // fly is delayed so the merge lands and the physics assigns coordinates
  // (centerOn no-ops on nodes without a position yet).
  const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyToNode = useCallback((nodeId: string) => {
    if (flyTimer.current) clearTimeout(flyTimer.current);
    flyTimer.current = setTimeout(() => canvasRef.current?.centerOn(nodeId), 900);
  }, []);
  useEffect(
    () => () => {
      if (flyTimer.current) clearTimeout(flyTimer.current);
    },
    [],
  );

  const { addUser, addTag, expand } = graph;
  const handlePickUser = useCallback(
    async (pubky: Pubky, source?: GraphExpandSource) => {
      const nodeId = `user:${pubky}`;
      markInteracted(interactedStep);
      await addUser(pubky);
      // Expands nodes that were already on the canvas; freshly added centers
      // arrive with their neighborhood and no-op here
      await expand(nodeId, undefined, source);
      flyToNode(nodeId);
    },
    [addUser, expand, flyToNode],
  );
  const handlePickTag = useCallback(
    async (label: string, source: GraphExpandSource) => {
      const nodeId = `tag:${label}`;
      markInteracted(interactedStep);
      await addTag(label);
      await expand(nodeId, undefined, source);
      flyToNode(nodeId);
    },
    [addTag, expand, flyToNode],
  );

  // Advanced lens preferences (design-off defaults)
  const { edgeChipsOn, tagHubsOn, toggleEdgeChips, toggleTagHubs } = useGraphStore();

  // Picks made in the global header search while on this page
  const searchTarget = useGraphStore((state) => state.searchTarget);
  useEffect(() => {
    if (!searchTarget) return;
    if (searchTarget.kind === 'user') {
      recordSearchPick('user', 'header');
      void handlePickUser(searchTarget.pubky as Pubky, 'search_pick');
    } else {
      recordSearchPick('tag', 'header');
      void handlePickTag(searchTarget.label, 'search_pick');
    }
    useGraphStore.getState().clearSearchTarget();
  }, [searchTarget, handlePickUser, handlePickTag]);

  const meId = currentUserPubky ? `user:${currentUserPubky}` : null;

  // "Followed by ..." strip data, straight from edges already on the canvas
  const proofUsers = useMemo(() => {
    if (!meId || !graph.selectedNode || graph.selectedNode.kind !== 'user' || graph.selectedNode.id === meId) {
      return [];
    }
    const ids = new Set(socialProof(meId, graph.selectedNode.id, graph.edges));
    return graph.nodes
      .filter((n): n is Extract<NexusGraphNode, { kind: 'user' }> => n.kind === 'user' && ids.has(n.id))
      .map((n) => ({ pubky: n.pubky, name: n.name, image: n.image }));
  }, [meId, graph.selectedNode, graph.edges, graph.nodes]);

  const spotlightClass = useCallback(
    (cls: HideableClass | null) => {
      setEdgeSpotlight(null);
      if (!cls) {
        setSpotlight(null);
        return;
      }
      const members = new Set<string>();
      for (const node of graph.nodes) {
        const nodeClass = node.kind === 'user' ? (graph.relationships.get(node.id) ?? 'extended') : node.kind;
        if (nodeClass === cls) members.add(node.id);
      }
      setSpotlight(members);
    },
    [graph.nodes, graph.relationships],
  );

  // Edge rows of the legend spotlight matching edges plus their endpoints
  const spotlightEdgeKind = useCallback(
    (kind: EdgeLegendKind | null) => {
      if (!kind) {
        setEdgeSpotlight(null);
        setSpotlight(null);
        return;
      }
      const follows = graph.edges.filter(
        (edge) =>
          (edge.type === 'FOLLOWS' || edge.type === 'FRIEND') &&
          edge.source !== graph.focusId &&
          edge.target !== graph.focusId,
      );
      const keys = new Set<string>();
      const endpoints = new Set<string>();
      if (kind === 'fresh') {
        const stamped = follows.filter((edge) => edge.indexed_at !== undefined);
        let min = Infinity;
        let max = -Infinity;
        for (const edge of stamped) {
          min = Math.min(min, edge.indexed_at!);
          max = Math.max(max, edge.indexed_at!);
        }
        if (min < max) {
          for (const edge of stamped) {
            // Same normalization as the canvas ramp; spotlight the bright end
            if ((edge.indexed_at! - min) / (max - min) >= 0.7) {
              keys.add(edgeKey(edge));
              endpoints.add(edge.source);
              endpoints.add(edge.target);
            }
          }
        }
      } else if (graph.communities) {
        for (const edge of follows) {
          const a = graph.communities.get(edge.source);
          const b = graph.communities.get(edge.target);
          if (a === undefined || b === undefined) continue;
          if ((kind === 'intra') === (a === b)) {
            keys.add(edgeKey(edge));
            endpoints.add(edge.source);
            endpoints.add(edge.target);
          }
        }
      }
      setEdgeSpotlight(keys.size > 0 ? keys : null);
      setSpotlight(endpoints.size > 0 ? endpoints : null);
    },
    [graph.edges, graph.focusId, graph.communities],
  );

  const hasTies = useMemo(
    () =>
      graph.edges.some(
        (edge) =>
          (edge.type === 'FOLLOWS' || edge.type === 'FRIEND') &&
          edge.source !== graph.focusId &&
          edge.target !== graph.focusId,
      ),
    [graph.edges, graph.focusId],
  );

  const spotlightProof = useCallback(
    (hovering: boolean) => {
      setEdgeSpotlight(null);
      if (!hovering || !meId || !graph.selectedNode) {
        setSpotlight(null);
        return;
      }
      const set = new Set<string>([meId, graph.selectedNode.id]);
      for (const user of proofUsers) set.add(`user:${user.pubky}`);
      setSpotlight(set);
    },
    [meId, graph.selectedNode, proofUsers],
  );

  const handleUserHover = useCallback((node: NexusGraphNode | null, screen: { x: number; y: number } | null) => {
    if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
    if (node && node.kind === 'user' && screen) {
      setHoverCard({ node, x: screen.x, y: screen.y });
    } else {
      // Grace period so the pointer can travel from node to card
      hoverCloseTimer.current = setTimeout(() => setHoverCard(null), 250);
    }
  }, []);

  // Design click semantics: a user click centers + focuses (and dismisses any
  // hover card); a chip click expands its tag into the graph; posts and hubs
  // keep the inspector panel. Touch has no hover card, so a second tap on the
  // focused user opens the bottom-sheet panel instead.
  const { recenter, select: graphSelect } = graph;
  const handleNodeClick = useCallback(
    (id: string) => {
      if (id.startsWith('user:')) {
        setHoverCard(null);
        if (isMobile && graph.focusId === id) {
          pulseEvent(GRAPH_EVENTS.NODE_INSPECTED, { surface: EXPLORER_SURFACE, kind: 'user' });
          graphSelect(id);
          return;
        }
        pulseEvent(GRAPH_EVENTS.RECENTERED, { surface: EXPLORER_SURFACE, via: 'node_click' });
        markInteracted(interactedStep);
        void recenter(id);
        canvasRef.current?.centerOn(id);
        return;
      }
      if (id.startsWith('ptag:')) {
        const label = id.split(':').slice(2).join(':');
        if (label) void handlePickTag(label, 'tag_chip');
        return;
      }
      // The prefix is the node's kind; the rest of the id identifies a person or a tag
      pulseEvent(GRAPH_EVENTS.NODE_INSPECTED, { surface: EXPLORER_SURFACE, kind: id.split(':')[0] });
      graphSelect(id);
    },
    [recenter, graphSelect, handlePickTag, isMobile, graph.focusId],
  );

  const handleRecenterSelf = useCallback(() => {
    if (!currentUserPubky) return;
    const nodeId = `user:${currentUserPubky}`;
    markInteracted(interactedStep);
    if (graph.nodes.some((n) => n.id === nodeId)) {
      pulseEvent(GRAPH_EVENTS.RECENTERED, { surface: EXPLORER_SURFACE, via: 'self_button' });
      void recenter(nodeId);
      canvasRef.current?.centerOn(nodeId);
    } else {
      void handlePickUser(currentUserPubky);
    }
  }, [currentUserPubky, graph.nodes, recenter, handlePickUser]);

  const handleTraceConnection = useCallback(
    (pubky: string) => {
      setHoverCard(null);
      void graph.tracePath(pubky as Pubky, 'hover_card');
    },
    [graph],
  );

  const handleLinkClick = useCallback((edge: SocialGraphVisualEdge, screen: { x: number; y: number }) => {
    // Any tag edge is inspectable; single-label edges just show one pill
    const labels = edge.labels ?? (edge.type === 'TAGGED' && edge.label ? [edge.label] : null);
    if (labels && labels.length > 0) {
      setTagPopover({ labels, sourceId: edge.source, targetId: edge.target, x: screen.x, y: screen.y });
    }
  }, []);

  const handleHop = useCallback(
    (entry: TrailEntry) => {
      pulseEvent(GRAPH_EVENTS.RECENTERED, { surface: EXPLORER_SURFACE, via: 'breadcrumb' });
      markInteracted(interactedStep);
      graph.focus(entry.id);
      canvasRef.current?.centerOn(entry.id);
    },
    [graph],
  );

  // A search-added graph counts as content even without a signed-in center
  const hasContent = graph.nodes.length > 1;
  const isEmpty = !graph.isLoading && !graph.error && !hasContent;

  // Tracked anchor points: overlays follow their canvas entity per frame
  const hoverNodeId = hoverCard?.node.id ?? null;
  const computeHoverPoint = useCallback(
    () => (hoverNodeId ? (canvasRef.current?.screenPositionOf(hoverNodeId) ?? null) : null),
    [hoverNodeId],
  );
  const hoverPoint = useTrackedPoint(hoverNodeId ? computeHoverPoint : null);

  const tagSourceId = tagPopover?.sourceId ?? null;
  const tagTargetId = tagPopover?.targetId ?? null;
  const computeTagPoint = useCallback(
    () => (tagSourceId && tagTargetId ? (canvasRef.current?.screenMidpointOf(tagSourceId, tagTargetId) ?? null) : null),
    [tagSourceId, tagTargetId],
  );
  const tagPoint = useTrackedPoint(tagSourceId ? computeTagPoint : null);

  const selectedNodeId = graph.selectedNode?.id ?? null;
  const computeSelectedPoint = useCallback(
    () => (selectedNodeId ? (canvasRef.current?.screenPositionOf(selectedNodeId) ?? null) : null),
    [selectedNodeId],
  );
  const selectedPoint = useTrackedPoint(selectedNodeId && !isMobile ? computeSelectedPoint : null);

  const renderNodePanel = (className: string) =>
    graph.selectedNode ? (
      <SocialGraphNodePanel
        className={className}
        node={graph.selectedNode}
        relationship={graph.relationships.get(graph.selectedNode.id) ?? 'extended'}
        isExpanded={graph.expandedIds.has(graph.selectedNode.id)}
        isExpanding={graph.isExpanding}
        proofUsers={proofUsers}
        onProofHover={spotlightProof}
        onExpand={(id) => {
          markInteracted(interactedStep);
          void graph.expand(id, undefined, 'panel');
        }}
        onRefreshNode={(id) => {
          markInteracted(interactedStep);
          void graph.refreshNode(id);
        }}
        onFocus={(id) => {
          graph.focus(id);
          canvasRef.current?.centerOn(id);
        }}
        onTracePath={(pubky) => void graph.tracePath(pubky, 'panel')}
        isTracing={graph.isTracing}
        onClose={() => graph.select(null)}
      />
    ) : null;

  return (
    <div
      ref={pageRef}
      // Full-bleed on phones (the desktop header is hidden below lg); on
      // desktop a hairline-bordered card inside the shell's container, below
      // the header with the same gutter as the feed's graph layout. Fullscreen
      // covers the viewport, header included.
      className={cn(
        'relative h-svh w-full overflow-hidden lg:h-[calc(100svh-var(--header-offset-main)-40px)] lg:rounded-lg lg:border lg:border-secondary',
        isFullscreen && 'fixed inset-0 z-50 h-auto bg-background lg:h-auto lg:rounded-none lg:border-0',
      )}
      data-cy="graph-page"
    >
      <SocialGraph
        ref={canvasRef}
        nodes={graph.nodes}
        edges={graph.edges}
        focusId={graph.focusId}
        selectedId={graph.selectedNode?.id ?? null}
        relationships={graph.relationships}
        opacityTiers={graph.opacityTiers}
        sizeTiers={graph.sizeTiers}
        ringId={graph.pathIds ? (graph.pathIds.at(-1) ?? graph.focusId) : graph.focusId}
        spotlight={spotlight}
        spotlightEdges={edgeSpotlight}
        pathIds={graph.pathIds}
        communities={graph.communities}
        communityLabels={graph.communityLabels}
        edgeChipsOn={edgeChipsOn}
        onNodeClick={handleNodeClick}
        onNodeExpand={(id) => {
          markInteracted(interactedStep);
          void graph.expand(id, undefined, 'double_click');
        }}
        onLinkClick={handleLinkClick}
        onUserHover={handleUserHover}
        onBackgroundClick={() => {
          graph.select(null);
          graph.clearPath();
          setTagPopover(null);
          setSpotlight(null);
          setEdgeSpotlight(null);
        }}
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-2 p-3 pr-16 lg:py-2 lg:pl-6">
        <Typography as="h1" size="lg" className="sr-only">
          {t('title')}
        </Typography>
        <GraphBreadcrumbs
          className="pointer-events-auto order-last min-w-0 shrink sm:order-none"
          trail={graph.trail}
          onHop={handleHop}
        />
        {/* Desktop search lives in the app header (it drives the graph on this
            page); the local field is the mobile affordance */}
        <GraphSearch
          className="pointer-events-auto w-full sm:ml-auto sm:w-56 lg:hidden"
          onPickUser={(pubky) => {
            recordSearchPick('user', 'inline');
            void handlePickUser(pubky, 'search_pick');
          }}
          onPickTag={(label) => {
            recordSearchPick('tag', 'inline');
            void handlePickTag(label, 'search_pick');
          }}
        />
      </div>

      <SocialGraphControls
        className="absolute top-14 right-3 z-10 sm:top-3 lg:top-6 lg:right-6"
        onZoomIn={() => {
          recordControl('zoom-in');
          canvasRef.current?.zoomIn();
        }}
        onZoomOut={() => {
          recordControl('zoom-out');
          canvasRef.current?.zoomOut();
        }}
        timeMachineOn={timeMachineOn}
        timeMachineAvailable={graph.timeBounds !== null}
        onToggleTimeMachine={() => {
          recordControl('time-toggle', timeMachineOn ? 'off' : 'on');
          setTimeMachineOn((prev) => {
            if (prev) graph.setTimeCap(null);
            return !prev;
          });
        }}
        onRecenterSelf={currentUserPubky ? handleRecenterSelf : undefined}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => {
          recordControl('fullscreen', isFullscreen ? 'off' : 'on');
          toggleFullscreen();
        }}
        advancedContent={
          <SocialGraphAdvancedPanel
            declutter={graph.declutter}
            onToggleDeclutter={() => {
              recordControl('declutter', graph.declutter ? 'off' : 'on');
              graph.toggleDeclutter();
            }}
            communitiesOn={graph.communitiesOn}
            onToggleCommunities={() => {
              recordControl('communities', graph.communitiesOn ? 'off' : 'on');
              graph.toggleCommunities();
            }}
            edgeChipsOn={edgeChipsOn}
            onToggleEdgeChips={() => {
              recordControl('edge-details', edgeChipsOn ? 'off' : 'on');
              toggleEdgeChips();
            }}
            tagHubsOn={tagHubsOn}
            onToggleTagHubs={() => {
              recordControl('tag-hubs', tagHubsOn ? 'off' : 'on');
              toggleTagHubs();
            }}
            physicsPaused={physicsPaused}
            onTogglePhysics={() => {
              const next = !physicsPaused;
              recordControl('physics', next ? 'on' : 'off');
              setPhysicsPaused(next);
              canvasRef.current?.setPaused(next);
            }}
            onReleasePins={() => {
              recordControl('release-pins');
              canvasRef.current?.releasePins();
            }}
            onFit={() => {
              recordControl('fit');
              canvasRef.current?.fit();
            }}
            legend={
              <SocialGraphLegend
                classCounts={graph.classCounts}
                hiddenClasses={graph.hiddenClasses}
                onHoverClass={spotlightClass}
                onToggleClass={(cls) => {
                  recordControl(`legend-${cls}`, graph.hiddenClasses.has(cls) ? 'on' : 'off');
                  graph.toggleClass(cls);
                }}
                showRecency={hasTies && edgeChipsOn}
                communitiesOn={graph.communitiesOn && graph.communities !== null}
                onHoverEdges={spotlightEdgeKind}
              />
            }
          />
        }
      />

      {graph.pathIds && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(GRAPH_PILL_CLASS, 'absolute top-14 left-3 z-10 sm:top-3 lg:top-6 lg:left-6')}
          onClick={() => {
            recordControl('path-exit');
            graph.clearPath();
          }}
          aria-label={t('panel.clearPath')}
          title={t('panel.clearPath')}
          data-cy="graph-path-exit"
        >
          <X className="size-4" />
        </Button>
      )}

      {timeMachineOn && graph.timeBounds && (
        <GraphTimeMachine
          className={cn(
            'absolute bottom-44 left-1/2 max-w-[92%] -translate-x-1/2 lg:bottom-6',
            graph.selectedNode && 'lg:left-[40%] xl:left-[45%]',
          )}
          bounds={graph.timeBounds}
          timestamps={graph.timelineStamps}
          cap={graph.timeCap}
          onCapChange={graph.setTimeCap}
          onClose={() => setTimeMachineOn(false)}
        />
      )}

      {isMobile
        ? renderNodePanel(
            'absolute inset-x-0 bottom-0 z-20 max-h-[65svh] w-full overflow-y-auto rounded-t-2xl rounded-b-none border-x-0 border-b-0 pb-[calc(5.5rem+env(safe-area-inset-bottom))]',
          )
        : graph.selectedNode &&
          selectedPoint && (
            <CanvasAnchoredPopover x={selectedPoint.x} y={selectedPoint.y} offset={18}>
              {renderNodePanel('max-h-[calc(100%-1.5rem)] w-80 overflow-y-auto')}
            </CanvasAnchoredPopover>
          )}

      {hoverCard && (
        <GraphUserHoverCard
          node={hoverCard.node}
          open={!graph.selectedNode || graph.selectedNode.id !== hoverCard.node.id}
          x={hoverPoint?.x ?? hoverCard.x}
          y={hoverPoint?.y ?? hoverCard.y}
          nodes={graph.nodes}
          edges={graph.edges}
          meId={meId}
          onTraceConnection={handleTraceConnection}
          onPointerEnter={() => {
            if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
          }}
          onPointerLeave={() => setHoverCard(null)}
        />
      )}

      {tagPopover && (
        <CanvasAnchoredPopover
          x={tagPoint?.x ?? tagPopover.x}
          y={tagPoint?.y ?? tagPopover.y}
          offset={10}
          className={cn(GRAPH_SURFACE_CLASS, 'flex w-auto max-w-56 flex-wrap gap-1.5 p-2.5 shadow-lg')}
          onPointerLeave={() => setTagPopover(null)}
          data-cy="graph-tag-popover"
        >
          {tagPopover.labels.map((label) => (
            <Tag
              key={label}
              name={label}
              onClick={(name) => {
                setTagPopover(null);
                void handlePickTag(name, 'tag_chip');
              }}
            />
          ))}
        </CanvasAnchoredPopover>
      )}

      {(graph.isExpanding || graph.isTracing || (graph.isLoading && hasContent)) && (
        <div
          className={cn(
            GRAPH_SURFACE_CLASS,
            'absolute bottom-24 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-1.5',
            'animate-in zoom-in-95 fade-in',
          )}
          data-cy="graph-busy"
        >
          <Spinner size="sm" className="size-3.5" />
          <Typography size="sm" className="text-muted-foreground">
            {tCommon('loading')}
          </Typography>
        </div>
      )}

      {(graph.isLoading || graph.error || isEmpty) && !hasContent && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {graph.isLoading ? (
            <Spinner />
          ) : (
            <div
              className={cn(
                GRAPH_SURFACE_CLASS,
                'pointer-events-auto flex max-w-sm flex-col items-center gap-4 p-8 text-center shadow-xl',
              )}
            >
              <Users className="size-8 text-muted-foreground" />
              <Typography as="p" className="text-muted-foreground">
                {!centerPubky && !hasContent ? t('states.noUser') : graph.error ? t('states.error') : t('states.empty')}
              </Typography>
              {graph.error && centerPubky && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    pulseEvent(GRAPH_EVENTS.RETRY_CLICKED, { surface: EXPLORER_SURFACE });
                    load(centerPubky);
                  }}
                  data-cy="graph-retry"
                >
                  <RotateCcw className="size-4" />
                  {t('states.retry')}
                </Button>
              )}
              {isEmpty && centerPubky && currentUserPubky === centerPubky && (
                <Button variant="secondary" asChild>
                  <Link href={APP_ROUTES.WHO_TO_FOLLOW}>{t('states.emptyCta')}</Link>
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
