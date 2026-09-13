# Credits & asset licensing

All third-party art shipped in `public/assets/` is listed here. **Verify the
licence column before any public or commercial release**, and keep this file
with any redistribution.

| Asset | File in repo | Source | Author | Licence | Modified? |
| --- | --- | --- | --- | --- | --- |
| Europe theatre map | `public/assets/maps/europe_blank_laea.svg` | [Europe blank laea location map.svg](https://commons.wikimedia.org/wiki/File:Europe_blank_laea_location_map.svg) (Wikimedia Commons) | Alexrk2 | **CC BY-SA 3.0** | No — byte-for-byte copy |
| Character parts (9 tiers) | `public/assets/characters/**` (97 PNGs) | [Characters Evil soldiers and ally soldiers](https://opengameart.org/content/characters-evil-soldiers-and-ally-soldiers) (OpenGameArt) | knik1985 | **CC-BY 3.0** | No — extracted from `Character_parts_0.zip`, top-level folder flattened |
| Weapons atlas | `public/assets/weapons/guns_0.svg` | [opengameart.org/sites/default/files/guns_0.svg](https://opengameart.org/sites/default/files/guns_0.svg) (OpenGameArt) | **unknown** | ⚠️ **UNVERIFIED — action needed** | No |

Everything else in this repository (source code, the procedural Canvas 2D
fallback sprites, the generated PWA icons and the procedural audio synthesis)
is original work created for this project.

## Required attribution texts

**Europe map (CC BY-SA 3.0):** "Europe blank laea location map" by Alexrk2,
via Wikimedia Commons, licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
Data from naturalearthdata.com.

**Character parts (CC-BY 3.0):** "Characters Evil soldiers and ally soldiers"
by [knik1985](https://opengameart.org/users/knik1985), via OpenGameArt,
licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

## Two licensing traps to be aware of

1. **The map is ShareAlike, not just Attribution.** A *derivative* of that SVG
   (recoloured, cropped, redrawn, converted for a tileset) must be released
   under CC BY-SA 3.0 or a compatible licence. Shipping it unmodified keeps the
   obligation to attribution only. If you want a permissive fallback, use the
   built-in procedural map instead, or swap in a public-domain map.
2. **`guns_0.svg` has an unverified licence.** The direct file URL was
   provided, but its OpenGameArt *content page* (which carries the licence tag)
   could not be located from this environment. Do not ship this file publicly
   until that is confirmed. The procedural weapons atlas in
   `src/engine/ProceduralSprites.ts` exists partly for this reason: delete the
   SVG and the game still runs.

## Asset provenance

Retrieved 2026-09-13. Download commands are reproducible:

```bash
curl -sSL -o public/assets/weapons/guns_0.svg \
  https://opengameart.org/sites/default/files/guns_0.svg
curl -sSL -o /tmp/Character_parts_0.zip \
  https://opengameart.org/sites/default/files/Character_parts_0.zip
python3 -c "import zipfile,os,shutil; d='public/assets/characters'; os.makedirs(d,exist_ok=True); \
z=zipfile.ZipFile('/tmp/Character_parts_0.zip'); \
[ (os.makedirs(os.path.dirname(os.path.join(d,p)),exist_ok=True), \
   shutil.copyfileobj(z.open(i), open(os.path.join(d,p),'wb'))) \
  for i in z.infolist() if '/' in i.filename and not i.filename.endswith('/') \
  for p in [i.filename.split('/',1)[1]] ]"
curl -sSL -o public/assets/maps/europe_blank_laea.svg \
  "https://commons.wikimedia.org/wiki/Special:FilePath/Europe_blank_laea_location_map.svg"
```
