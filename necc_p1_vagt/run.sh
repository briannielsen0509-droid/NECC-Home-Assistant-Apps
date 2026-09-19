#!/usr/bin/with-contenv bashio
set -e

export NECC_HA_TOKEN="${SUPERVISOR_TOKEN:-}"
export NECC_NO_BROWSER=1
export NECC_OPTIMIZER_CONFIG="/homeassistant/necc/optimizer/config/necc_optimizer.json"

echo "NECC P1 VAGT RPi5 1.0.1 starter..."
echo "Home Assistant API: Supervisor"
echo "Web/Ingress port: 8791"
echo "Optimizer config: /homeassistant/necc/optimizer/config/necc_optimizer.json (read-only)"

cd /app
exec python3 /app/server.py
