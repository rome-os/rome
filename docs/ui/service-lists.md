# Service lists

How a page reads when it lists many services, as Settings › Connections does. The rows repeat, so whatever one row carries, the page carries many times.

## Marks

- **One tile for every service.** A mark sits on the tile from `brandTile`: white, or the muted surface in the dark theme, so a long list does not glare. A brand keeps its color in both themes, and a one-color mark takes the theme's ink. Filling a tile with a brand's color makes each row compete with its neighbors.
- **A real logo beats a drawn glyph.** A service with a logo in `composio-logos.tsx` shows it. A monochrome glyph is the fallback for a service without one.
- **A list takes the small tile.** A card in a list uses `size="sm"`, and a detail or dialog header keeps `md`, where one mark stands alone.

## Status

- **A healthy row stays quiet.** It shows its dot, and the word goes to screen readers through `quiet`. The section heading already says these services are connected.
- **A row that needs the guardian reads.** Attention shows a warning triangle and the word, so it does not rest on color alone.
- **One mark per status.** A status never pairs a dot with an icon.
