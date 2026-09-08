'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Loader2, StickyNote, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/atoms/Button/Button';
import { toSafeScreenName } from '@/atoms/PulseInit/PulseInit';
import { Spinner } from '@/atoms/Spinner/Spinner';
import { Typography } from '@/atoms/Typography/Typography';
import { GRAPH_PILL_CLASS } from '@/config/theme';
import { useFullscreenToggle } from '@/hooks/useFullscreenToggle/useFullscreenToggle';
import { useGraphDebug } from '@/hooks/useGraphDebug/useGraphDebug';
import { useSearchTags } from '@/hooks/useSearchStreamId/useSearchStreamId';
import type { HideableClass } from '@/hooks/useSocialGraph/useSocialGraph.types';
import { socialProof } from '@/hooks/useSocialGraph/useSocialGraph.utils';
import { useStreamGraph } from '@/hooks/useStreamGraph/useStreamGraph';
import { useTrackedPoint } from '@/hooks/useTrackedPoint/useTrackedPoint';
import { pulseEvent, pulseScreen } from '@/libs/observability/pulse';
import { FEED_SURFACE, GRAPH_EVENTS, pulseGraphControl } from '@/libs/observability/pulse.graph';
import { cn } from '@/libs/utils/utils';
import type { Pubky } from '@/models/models.types';
import { GraphTimeMachine } from '@/molecules/GraphTimeMachine/GraphTimeMachine';
import { SocialGraphAdvancedPanel } from '@/molecules/SocialGraphAdvancedPanel/SocialGraphAdvancedPanel';
import { SocialGraphControls } from '@/molecules/SocialGraphControls/SocialGraphControls';
import { SocialGraphLegend } from '@/molecules/SocialGraphLegend/SocialGraphLegend';
import { GraphUserHoverCard } from '@/organisms/GraphUserHoverCard/GraphUserHoverCard';
import { SocialGraph } from '@/organisms/SocialGraph/SocialGraph';
import type { SocialGraphHandle } from '@/organisms/SocialGraph/SocialGraph.types';
import { SocialGraphNodePanel } from '@/organisms/SocialGraphNodePanel/SocialGraphNodePanel';
import type { NexusGraphNode, NexusGraphUserNode } from '@/services/nexus/graph/graph.types';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useGraphStore } from '@/stores/graph/graph.store';

export interface StreamGraphPostsProps {
  postIds: string[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  className?: string;
}

type HoverCard = { node: NexusGraphUserNode; x: number; y: number };

/** The graph layout is a mode inside several stream routes, not a route of its own. */
const FEED_GRAPH_SCREEN = '/feed/graph';

const recordControl = (control: string, state?: 'on' | 'off') => pulseGraphControl(FEED_SURFACE, control, state);

/**
 * StreamGraphPosts
 *
 * The feed's graph layout: the current stream as a living constellation.
 * Authors are avatar clusters with their profile-tag chips and post glyphs;
 * the signed-in user always seeds the view. Load-more merges the next page
 * in with birth pulses instead of appending rows.
 */
export function StreamGraphPosts({
  postIds,
  loading,
  loadingMore,
  hasMore,
  loadMore,
  className,
}: StreamGraphPostsProps) {
  const t = useTranslations('graph');
  const { currentUserPubky } = useAuthStore();
  // On /search the URL's tags are the reason these posts are here; pin their
  // hubs so the results visibly hang off what was searched (empty elsewhere)
  const searchedTags = useSearchTags();
  const graph = useStreamGraph(postIds, searchedTags);
  const canvasRef = useRef<SocialGraphHandle>(null);
  const { isFullscreen, toggleFullscreen } = useFullscreenToggle(() => canvasRef.current?.fit());
  const [spotlight, setSpotlight] = useState<Set<string> | null>(null);
  const [timeMachineOn, setTimeMachineOn] = useState(false);
  const [physicsPaused, setPhysicsPaused] = useState(false);
  const [hoverCard, setHoverCard] = useState<HoverCard | null>(null);
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A recenter click flies the camera itself; the growth auto-fit below must
  // not undo it when the expansion merge lands
  const recenterAt = useRef(0);

  const { edgeChipsOn, tagHubsOn, toggleEdgeChips, toggleTagHubs } = useGraphStore();
  const meId = currentUserPubky ? `user:${currentUserPubky}` : null;

  // QA/debug surface for the cypress interaction audit (debug builds only)
  const { focusId: graphFocusId, pathIds: graphPathIds } = graph;
  useGraphDebug(canvasRef, {
    focusId: useCallback(() => graphFocusId, [graphFocusId]),
    pathIds: useCallback(() => graphPathIds, [graphPathIds]),
  });

  // Mount, not the layout picker: a stored preference can restore the graph without a click
  const layoutReported = useRef(false);
  useEffect(() => {
    if (layoutReported.current) return;
    layoutReported.current = true;
    pulseEvent(GRAPH_EVENTS.LAYOUT_SELECTED, { surface: FEED_SURFACE });
  }, []);

  // Owned only while this layout is mounted: the cleanup hands the route's own screen back,
  // or every later event in the session still reports '/feed/graph'
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname) return;
    pulseScreen(FEED_GRAPH_SCREEN);
    return () => pulseScreen(toSafeScreenName(pathname));
  }, [pathname]);

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

  // Re-fit the camera once each merged page settles, but only when the RAW
  // graph grew: filter toggles and time-machine scrubs also change the visible
  // count and must not yank the camera around. Recenter-driven growth is
  // exempt: the click already flew the camera onto its target.
  const prevRawCount = useRef(0);
  useEffect(() => {
    if (graph.rawNodeCount <= prevRawCount.current) {
      prevRawCount.current = graph.rawNodeCount;
      return;
    }
    prevRawCount.current = graph.rawNodeCount;
    if (Date.now() - recenterAt.current < 3000) return;
    const timer = setTimeout(() => canvasRef.current?.fit(), 1400);
    return () => clearTimeout(timer);
  }, [graph.rawNodeCount]);

  // Design click semantics: user click centers + focuses; a chip click
  // expands its tag into the graph; posts/hubs keep the inspector panel
  const { recenter, addTag, select: graphSelect } = graph;
  const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flyTimer.current) clearTimeout(flyTimer.current);
    },
    [],
  );
  const handleNodeClick = useCallback(
    (id: string) => {
      if (id.startsWith('user:')) {
        setHoverCard(null);
        pulseEvent(GRAPH_EVENTS.RECENTERED, { surface: FEED_SURFACE, via: 'node_click' });
        recenterAt.current = Date.now();
        void recenter(id);
        canvasRef.current?.centerOn(id);
        return;
      }
      if (id.startsWith('ptag:')) {
        const label = id.split(':').slice(2).join(':');
        if (!label) return;
        recenterAt.current = Date.now();
        void addTag(label);
        // Fly once the merge lands and the physics places the hub
        if (flyTimer.current) clearTimeout(flyTimer.current);
        flyTimer.current = setTimeout(() => canvasRef.current?.centerOn(`tag:${label}`), 900);
        return;
      }
      graphSelect(id);
    },
    [recenter, addTag, graphSelect],
  );

  const handleRecenterSelf = useCallback(() => {
    if (!meId) return;
    if (graph.nodes.some((n) => n.id === meId)) {
      pulseEvent(GRAPH_EVENTS.RECENTERED, { surface: FEED_SURFACE, via: 'self_button' });
      recenterAt.current = Date.now();
      void recenter(meId);
      canvasRef.current?.centerOn(meId);
    }
  }, [meId, graph.nodes, recenter]);

  const handleUserHover = useCallback((node: NexusGraphNode | null, screen: { x: number; y: number } | null) => {
    if (hoverCloseTimer.current) clearTimeout(hoverCloseTimer.current);
    if (node && node.kind === 'user' && screen) {
      setHoverCard({ node, x: screen.x, y: screen.y });
    } else {
      hoverCloseTimer.current = setTimeout(() => setHoverCard(null), 250);
    }
  }, []);

  const handleTraceConnection = useCallback(
    (pubky: string) => {
      setHoverCard(null);
      void graph.tracePath(pubky as Pubky, 'hover_card');
    },
    [graph],
  );

  const hoverNodeId = hoverCard?.node.id ?? null;
  const computeHoverPoint = useCallback(
    () => (hoverNodeId ? (canvasRef.current?.screenPositionOf(hoverNodeId) ?? null) : null),
    [hoverNodeId],
  );
  const hoverPoint = useTrackedPoint(hoverNodeId ? computeHoverPoint : null);

  const isEmpty = !loading && graph.nodes.length === 0;

  return (
    <div
      className={cn(
        'relative h-[70svh] min-h-96 w-full overflow-hidden rounded-lg border border-secondary lg:h-[calc(100svh-184px)]',
        isFullscreen && 'fixed inset-0 z-50 h-auto rounded-none border-0 bg-background lg:h-auto',
        className,
      )}
      data-cy="stream-graph"
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
        pathIds={graph.pathIds}
        communities={null}
        communityLabels={new Map()}
        edgeChipsOn={edgeChipsOn}
        onNodeClick={handleNodeClick}
        onNodeExpand={(id) => void graph.expand(id, undefined, 'double_click')}
        onUserHover={handleUserHover}
        onBackgroundClick={() => {
          graph.select(null);
          graph.clearPath();
          setSpotlight(null);
        }}
      />

      <SocialGraphControls
        className="absolute top-6 right-6 z-10"
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
        onRecenterSelf={meId ? handleRecenterSelf : undefined}
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
            communitiesOn={false}
            onToggleCommunities={() => undefined}
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
              />
            }
          />
        }
      />

      {graph.pathIds && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(GRAPH_PILL_CLASS, 'absolute top-6 left-6 z-10')}
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
          className="absolute bottom-16 left-1/2 max-w-[92%] -translate-x-1/2"
          bounds={graph.timeBounds}
          timestamps={graph.timelineStamps}
          cap={graph.timeCap}
          onCapChange={graph.setTimeCap}
          onClose={() => setTimeMachineOn(false)}
        />
      )}

      {graph.selectedNode && (
        <SocialGraphNodePanel
          // Above the controls (z-10) so the pills never cover the panel's
          // close button, below the sticky header (20) this card scrolls under
          className="absolute top-3 right-3 z-[15] max-h-[calc(100%-1.5rem)] max-w-[calc(100%-5rem)] overflow-y-auto"
          node={graph.selectedNode}
          relationship={graph.relationships.get(graph.selectedNode.id) ?? 'extended'}
          isExpanded={graph.expandedIds.has(graph.selectedNode.id)}
          isExpanding={graph.isExpanding}
          proofUsers={proofUsers}
          onProofHover={() => undefined}
          onExpand={(id) => void graph.expand(id, undefined, 'panel')}
          onRefreshNode={graph.refreshNode}
          onFocus={(id) => canvasRef.current?.centerOn(id)}
          onTracePath={(pubky) => void graph.tracePath(pubky, 'panel')}
          isTracing={graph.isTracing}
          onClose={() => graph.select(null)}
        />
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

      {hasMore && !isEmpty && (
        <Button
          variant="ghost"
          size="sm"
          className={cn(GRAPH_PILL_CLASS, 'absolute bottom-6 left-6 w-auto gap-2 px-3.5 text-xs font-bold')}
          disabled={loadingMore}
          onClick={() => {
            pulseEvent(GRAPH_EVENTS.STREAM_MERGE_MORE, {
              surface: FEED_SURFACE,
              total_nodes: String(graph.rawNodeCount),
            });
            loadMore();
          }}
          data-cy="stream-graph-load-more"
        >
          {loadingMore ? <Loader2 className="size-4 animate-spin" /> : <StickyNote className="size-4" />}
          {t('stream.loadMore')}
        </Button>
      )}

      {(loading || isEmpty) && (
        <div className="absolute inset-0 flex items-center justify-center">
          {loading ? (
            <Spinner />
          ) : (
            <Typography as="p" className="text-muted-foreground">
              {t('stream.empty')}
            </Typography>
          )}
        </div>
      )}
    </div>
  );
}
