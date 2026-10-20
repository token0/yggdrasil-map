# Changelog

## 2.3.0

### Changed
- Sharp map: canvases render at the device pixel ratio (up to 3x) from the
  start, with an exact backing-store scale (no resampling); only a redraw
  slower than 150 ms steps the resolution down. Small dots are drawn as
  circles unless they are under 3 device pixels. Touch devices use a 10%
  margin around the screen (was 25%) to keep the redraw cheap.
- Maps over 500 nodes use a cluster layout: the backbone tree's skeleton
  (non-leaf nodes, ~25%) is laid out with sfdp, every skeleton node gets a
  disk sized for its leaves, overlapping disks are pushed apart, and leaves
  sit on concentric rings around their parent one spacing apart. No two dots
  share a spot any more (minimum distance 0.99 leaf spacings on a 10k-node
  map, was 0.02), and hubs' inner rings start outside their own dot. The
  layout is deterministic across renders.
- Height mode: height 0 (about half of all nodes) is drawn smaller and dimmer
  so the other heights stand out.

### Added
- Back button and Escape cancel the open view (selected node, expanded
  sheet, search) instead of leaving the page; with nothing open, back works
  as usual. Deep links (#address) still open the node.


## 2.2.1

### Changed
- Zoomed out (up to the fitted zoom) dots are the small v2.1 sizes again;
  zooming in blends smoothly to the larger v2.2 sizes, reached at 4x.


## 2.2.0

### Added
- Address height filter next to "Color by" (Height min–max, ✕ to clear):
  non-matching nodes are dimmed, matching ones keep their colours and labels,
  and with no node selected the panel lists the matching nodes, highest
  first (up to 300). Legend chips are quick filters: tap a class to show only
  it, tap again to clear. The filter is remembered per browser.

### Changed
- Dots grow when zooming in (radius ~ zoom^0.6, so neighbours separate) and
  start from a size derived from the map's density; bigger at every zoom
  level (2.5–7 px base, up to 48 px).
- Node labels on the map are white on the dark theme (near-black on light)
  with a halo, readable over any dot or link colour.
- Height classes: 0, 1, 2, 3, 4, 5–7, 8–11, 12+ with a new palette: the two
  closest colours are 23 CIEDE2000 apart on black (was 16), neighbouring
  classes 27–39 apart; all >= 3.9:1 contrast on their background.
- Panels are opaque; node outlines on the dark theme are subtler and only on
  dots >= 4 px; the legend hides "unknown" when no node has unknown height.

### Fixed
- Names containing &, <, >, quotes showed as HTML entities on the map.
- Taps prefer nodes matching the filter over dimmed ones nearby.


## 2.1.0

### Fixed
- 2.0 slowdown on phones and PCs: during any pan or zoom (touch, mouse drag,
  wheel, trackpad pinch) the already drawn map is moved with a CSS transform
  and redrawn once when the gesture ends; hover and selection are drawn on a
  separate overlay layer and never trigger a full redraw.
- Links are stroked in chunks instead of one huge translucent path; tiny dots
  are drawn as squares; 1x resolution by default with HiDPI only where a full
  redraw is fast.

### Changed
- Initial view is a backbone tree computed from the peer graph, laid out as a
  tree; selecting a node shows all its peer links and, faintly, its peers'
  links (capped at 3000, then only links among its peers).
- Dot size follows the peer count (area proportional); centrality stays in the
  node panel.
- Address height colours are discrete classes (0, 1, 2, 3, 4, 5–7, 8+) with a
  chip legend, each with >= 3:1 contrast on its background; unknown height is a
  hollow ring.
- Map data split into a compact graph.json (nodes + tree) and links.json (all
  links), nodes referenced by index, served pre-compressed: 7 MB -> ~0.5 MB
  over the wire for a 10k-node network. Render time 30 s -> 16 s.

### Added
- `/bench` page timing renderer variants on the current device.

## 2.0.0

- Touch: pinch and drag move and zoom the map, never the page; tap selects
  with a finger-sized hit area; mouse wheel and trackpad pinch zoom around the
  cursor.
- Mobile layout: bottom sheet with handle (collapsed / half / full), 16 px base
  text, 44 px touch targets, addresses fitted on one line, scrollable peer list.
- Dark theme on touch devices or when the OS prefers dark.
- Height byte coloured inside every address.
- Batched drawing, HiDPI (regression: slow on phones, fixed in 2.1).
- Source link and About page point to token0/yggdrasil-map; version shown.

## 1.0.0

- Python 3 port; fixes for root self-link, collector hang on socket close,
  crash when the external node list is unreachable.
- "Color by" switch: peer count or address height; address height in the panel.
- Docker image with an embedded, contained Yggdrasil node (official 0.5.14
  release, checksum-pinned; no TUN, no listeners, no multicast); config
  generated into the stack directory; supervised node; collect/render loop.
- Built by GitHub Actions, published to ghcr.io, pulled by the Dockge stack.
- Peer-graph crawler (debug_remoteGetPeers) with partial snapshots and progress
  logging; lookups collector kept.
- Large graphs: sfdp layout, sampled centrality, fast page load.
