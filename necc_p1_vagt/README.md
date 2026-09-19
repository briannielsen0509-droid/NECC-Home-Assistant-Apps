# NECC P1 VAGT – RPi5 / Home Assistant app 1.0.1

Fix-version for Home Assistant OS 17.3 / Supervisor 2026.09.x.

Changes from 1.0.0:
- Uses current `homeassistant_config` map syntax.
- Home Assistant configuration is mounted read-only at `/homeassistant`.
- Optimizer price config points to `/homeassistant/necc/optimizer/config/necc_optimizer.json`.
- Dockerfile uses current Home Assistant multi-arch base and required app labels.
- Keeps Supervisor API token flow; no `HA_TOKEN.txt` required on Pi.
- P1 remains read-only; no HA/EMMA/Huawei write path is added.
