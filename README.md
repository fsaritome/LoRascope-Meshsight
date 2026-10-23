# LoRascope · Meshsight

by **Ferit Sari Tomé**

Plan LoRa mesh links (MeshCore, Meshtastic): line of sight, Fresnel clearance, knife-edge obstacle loss, link margin and coverage maps, for any point on earth.

**Live:** https://fsaritome.github.io/LoRascope-Meshsight/

## Features
- Click anywhere to place antenna A (and optionally a point B); terrain loads live around it.
- Path profile with the first Fresnel zone, earth curvature and obstacle highlighting, synced with the map while you slide over it.
- Coverage map from antenna A: terrain loss or link margin, 10–30 km.
- All known MeshCore repeaters within range, ranked by path loss (list refreshed daily by a GitHub Action).
- Map, satellite, topo and (in Bavaria) sharp official aerial imagery.
- Shareable links: the URL keeps antenna, point B, heights and radio settings.

## Data
- Terrain: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen; SRTM, EU-DEM © EEA and others)
- Maps: © OpenStreetMap contributors, OpenTopoMap (CC-BY-SA), Esri World Imagery, Bayerische Vermessungsverwaltung (CC BY 4.0)
- Repeaters: [MeshCore map](https://map.meshcore.dev) (`data/nodes.json`, updated by `.github/workflows/update-nodes.yml`)

## Model
Antenna heights are above ground, antennas assumed outdoors. Obstacle loss uses the single strongest knife edge (ITU-R P.526 approximation), earth curvature with k = 4/3. Put roof, foliage near you, cable and local noise into "Extra losses". The result is a planning aid, not a guarantee.

© 2026 Ferit Sari Tomé. All rights reserved.
