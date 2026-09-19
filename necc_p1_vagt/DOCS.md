# NECC P1 VAGT

Runs the frozen NECC P1 VAGT 0.5.3 baseline on Home Assistant / Raspberry Pi 5.

- Home Assistant API access through Supervisor token
- Ingress enabled
- LAN port 8791
- Home Assistant config mounted read-only
- No Huawei/EMMA writes


## 1.0.2 direction fix
P1 flow direction is normalized robustly; the source remains read-only.
