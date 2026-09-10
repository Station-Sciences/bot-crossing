# Bundled art

The `.glb` files in this directory are built from CC0 asset packs — three by
**[Kay Lousberg](https://kaylousberg.com)**, one by **[Kenney](https://kenney.nl)** and one by
**[Quaternius](https://quaternius.com)**. They are **not** covered by the project's MIT
licence — they are [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), which places
them in the public domain.

| File | Built from | Licence |
| --- | --- | --- |
| `spacebase.glb` | [KayKit : Space Base Bits](https://kaylousberg.itch.io/space-base-bits) | CC0 1.0 |
| `crew.glb` | [KayKit : Character Animations](https://kaylousberg.itch.io/kaykit-character-animations) | CC0 1.0 |
| `forest.glb` | [KayKit : Forest Nature Pack](https://kaylousberg.itch.io/kaykit-forest) | CC0 1.0 |
| `desertbase.glb` | [Kenney : Space Kit](https://kenney.nl/assets/space-kit) v1.0 and [Quaternius : Ultimate Space Kit](https://quaternius.com/packs/ultimatespacekit.html) | CC0 1.0 |

`desertbase.glb` provenance: the Kenney models come from the pack's own
[zip](https://kenney.nl/media/pages/assets/space-kit/20874c75ac-1677698978/kenney_space-kit.zip);
the Quaternius models were fetched via the [poly.pizza mirror](https://poly.pizza/bundle/Ultimate-Space-Kit-YWh743lqGX)
of the same pack (licence confirmed CC0 in the [Quaternius FAQ](https://quaternius.com/faq.html)).
Both downloaded 2026-09-10. Their colours are not the originals' — `tools/build-desert-kit.mjs`
repaints every model into a generated desert atlas.

CC0 requires nothing of you. Crediting Kay, Kenney and Quaternius costs nothing either.

See the repository README under "Where the art comes from" for how these are packed, and
"Rebuilding them" if you want to regenerate them from the original packs.
