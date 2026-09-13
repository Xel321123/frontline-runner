# Credits & asset licensing

**The battlefield has no third-party art at all.** Every soldier, helmet, tank,
strongpoint, shadow, muzzle flash, particle and terrain layer is drawn at
runtime with Canvas 2D path primitives in `src/render/` — there are no sprite
sheets, no character packs and no image downloads. The only third-party file in
the repository is the campaign-map background used by the *menu* screen:

| Asset | File in repo | Source | Author | Licence | Modified? |
| --- | --- | --- | --- | --- | --- |
| Europe theatre map | `public/assets/maps/europe_blank_laea.svg` | [Europe blank laea location map.svg](https://commons.wikimedia.org/wiki/File:Europe_blank_laea_location_map.svg) (Wikimedia Commons) | Alexrk2 | **CC BY-SA 3.0** | No — byte-for-byte copy |

Everything else — source code, the procedural unit and terrain renderer, the
generated PWA icons and the procedural audio synthesis — is original work
created for this project.

## Required attribution

**Europe map (CC BY-SA 3.0):** "Europe blank laea location map" by Alexrk2, via
Wikimedia Commons, licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
Data from naturalearthdata.com.

## One licensing note

**The map is ShareAlike, not just Attribution.** A *derivative* of that SVG
(recoloured, cropped, redrawn, converted for a tileset) must be released under
CC BY-SA 3.0 or a compatible licence. Shipping it unmodified keeps the obligation
to attribution only. It is loaded as a single `<img>` on the campaign-map screen;
deleting it degrades that screen's background but does not affect the battle,
which needs no image files whatsoever.

## Asset provenance

Retrieved 2026-09-13. The download is reproducible:

```bash
curl -sSL -o public/assets/maps/europe_blank_laea.svg \
  "https://commons.wikimedia.org/wiki/Special:FilePath/Europe_blank_laea_location_map.svg"
```

### Removed in the tug-of-war refactor

The earlier runner build shipped a 97-file character-pack PNG set and a weapons
SVG. Both were deleted when the game moved to 100% procedural graphics: the
character pack (CC-BY 3.0, knik1985, OpenGameArt) and `guns_0.svg` (licence
unverifiable from this environment) are no longer part of the project, which
also retires that unresolved licensing risk. The PWA precache dropped from
115 entries / 3.8 MiB to 17 entries / 1.5 MiB as a result.
