# Imagegen prompt set

Generated with the built-in `imagegen` tool on 2026-08-14. All outputs requested genuine transparency, no text, no letters, no initials, no numbers, no watermark, and a silhouette suitable for 16–54 px UI use.

## 2026-08-14 light-palette revision

The renderer moved from near-black to warm paper surfaces (`#EBE8DE` and
`#F4F1E8`). The four owned marks were edited from their original images with
the following shared production constraints:

```text
Preserve the existing concept and recognizable geometry, but redraw it as a cleaner flat small-size logo for warm light UI backgrounds #EBE8DE and #F4F1E8. Replace white/off-white structural strokes with dark ink #1B1D22. Use deep green #245043 as the primary accent, with restrained ochre #9A6700 and muted violet #7257A8 only where the role needs them. Remove fuzzy edges, halo, texture, bevel and pseudo-3D treatment. Center the mark with even transparent margin. Genuine transparent alpha; no text, letters, initials, numbers, wordmark, watermark, gradient, shadow, glow, mockup or enclosing tile.
```

Per-mark concepts retained:

- `codex-orchestra-light-v2.png`: conductor hub, three routed nodes and baton gesture; legible from 16–52 px.
- `role-frontend-light-v2.png`: exactly one open viewport, one layout panel and one pointer wedge.
- `role-engineer-light-v2.png`: exactly one open hardware ring, one terminal chevron and one status node.
- `provider-generic-light-v2.png`: exactly two opposing connector arcs and one central node.

Imagegen's first light-palette pass rendered a checkerboard instead of real
alpha. A second edit explicitly removed that backdrop. The accepted outputs
were then alpha-verified and normalized to 512 × 512 with a 40 px safe area.

## Native app icon revision

```text
Create the native desktop app icon variant for Codex Orchestra using the referenced application mark as the exact identity reference. Place a simplified, bolder version of the orchestration/conductor symbol inside one deep forest-green #245043 rounded-square tile. Draw the symbol primarily in warm paper #F4F1E8, with a dark ink #1B1D22 central hub and tiny ochre #9A6700 and muted violet #7257A8 node accents. Preserve the conductor hub, three routed nodes and baton gesture, but remove fine detail so it survives at 16 px. Flat, crisp, geometric, no text, letters, initials, numbers, wordmark, watermark, checkerboard, mockup, gradient, shadow, glow, bevel or 3D. Outer rounded corners use genuine transparent alpha.
```

The accepted `app-icon-light-v2.png` is a 512 × 512 RGBA master. Tauri CLI
generated the Windows, macOS, iOS and Android icon matrices from this master.

## Codex Orchestra

```text
Use case: logo-brand
Asset type: primary application logo mark for Codex Orchestra, used in a 30 px sidebar badge, 44 px loading screen, and desktop app icon
Primary request: create an original abstract orchestration symbol: one central conductor hub coordinating three compact routing nodes along three disciplined parallel paths, with a subtle baton-like diagonal gesture; communicate local control, routing, coordination, and precision
Style/medium: vector-friendly flat logo mark, crisp geometric silhouette, thick simple shapes, minimal negative space, production-quality app icon
Composition/framing: single centered square mark, generous transparent margin, balanced at very small sizes
Color palette: off-white plus restrained teal #2DD4BF, with tiny amber #FBBF24 and violet #A78BFA accents only if they remain legible; designed for a near-black #0B0D12 interface
Constraints: genuinely transparent background and preserved alpha; absolutely no text, no letters, no initials, no numbers, no wordmark, no watermark; no gradients, no shadows, no mockup, no border tile, no surrounding square; strong silhouette at 16 px; original design, not similar to OpenAI or any third-party logo
Avoid: CO monogram, musical-note cliché, purple gradient, 3D rendering, thin hairlines, busy detail
```

## Frontend role

```text
Use case: logo-brand
Asset type: revised compact role icon for the Frontend agent inside Codex Orchestra, displayed at 28–54 px
Primary request: replace the earlier detailed Frontend concept with an original symbol made from exactly three bold geometric elements: one open rounded viewport frame, one smaller violet layout panel, and one teal triangular pointer wedge; communicate interface composition without any letters
Input images: use the previous Codex Orchestra marks only as palette and stroke-weight references; the earlier detailed Frontend icon must be simplified radically
Style/medium: ultra-simple vector-friendly flat mark, thick uniform geometry, crisp high-contrast silhouette
Composition/framing: single centered square mark, generous transparent margin, no scene
Color palette: off-white, violet #A78BFA, and teal #2DD4BF, designed for #0B0D12
Constraints: genuinely transparent background; exactly three main geometric elements; absolutely no text, no letters, no initials, no numbers, no wordmark, no watermark; no browser chrome dots, no toolbars, no gradients, no shadows, no mockup, no surrounding square, no 3D; instantly legible at 20 px; original design
Avoid: letter F, multiple windows, detailed UI controls, browser logos, thin lines, extra dots, busy detail
```

## Engineer role

```text
Use case: logo-brand
Asset type: compact role icon for the Engineer agent inside Codex Orchestra, displayed at 28–54 px
Primary request: create an original engineering symbol made from exactly three bold geometric elements: one open hexagonal hardware ring, one centered terminal chevron formed as a solid angle, and one small teal status node; communicate systems engineering without any letters
Input images: Codex Orchestra marks are strict palette/weight references only; do not copy their subjects or complexity
Style/medium: radically simple vector-friendly flat mark, thick uniform geometry, crisp high-contrast silhouette, production UI icon
Composition/framing: single centered square mark, generous transparent margin, no scene
Color palette: off-white with restrained amber #FBBF24 and teal #2DD4BF accents, designed for #0B0D12
Constraints: genuinely transparent background; exactly three main geometric elements; absolutely no text, no letters, no initials, no numbers, no wordmark, no watermark; no gradients, no shadows, no mockup, no surrounding square, no 3D; instantly legible at 20 px; original design
Avoid: letter G, dense gears with teeth, tools, code text, thin lines, extra dots, busy detail
```

## Generic provider

```text
Use case: logo-brand
Asset type: generic fallback provider icon inside Codex Orchestra, displayed at 28 px when a future provider has no official logo
Primary request: create an original universal connection symbol made from exactly three bold geometric elements: two opposing rounded connector arcs and one centered teal node, communicating a provider connection without identifying any company
Input images: Codex Orchestra marks are strict palette/weight references only; use the same bold geometry but a distinct subject
Style/medium: radically simple vector-friendly flat mark, thick uniform geometry, crisp high-contrast silhouette
Composition/framing: single centered square mark, generous transparent margin, no scene
Color palette: off-white and teal #2DD4BF only, designed for #0B0D12
Constraints: genuinely transparent background; exactly three main geometric elements; absolutely no text, no letters, no initials, no numbers, no wordmark, no watermark; no gradients, no shadows, no mockup, no surrounding square, no 3D; instantly legible at 16 px; original neutral design
Avoid: question mark, plug brand logos, chain-link cliché, letter shapes, thin lines, extra dots, busy detail
```
