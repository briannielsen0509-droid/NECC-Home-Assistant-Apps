# Changelog

## 1.0.2
- Fixes false `LIVE · P1 (DELVIS)` when the Home Assistant direction entity is valid.
- Normalizes hidden Unicode/control characters in the direction state.
- Accepts IMPORT/EXPORT variants without changing the Home Assistant entity.
- Uses the entity's import/export icon as a safe fallback.
- Adds `directionRaw` to `/api/live` for diagnostics.
- No changes to price logic, phases, Optimizer, EMMA or Huawei control.

## 1.0.1
- Home Assistant Apps compatible package
- `homeassistant_config` read-only mapping
- Ingress on port 8791
- Supervisor API token support
- Raspberry Pi 5 / aarch64
