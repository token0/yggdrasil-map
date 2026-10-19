# Changelog

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
