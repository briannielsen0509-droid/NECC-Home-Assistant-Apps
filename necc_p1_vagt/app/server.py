#!/usr/bin/env python3
"""NECC P1 VAGT 0.5.3: lokal webserver, HA-bro og fakturavalideret prisvisning."""
from __future__ import annotations

import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import unicodedata
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "LIVE_CONFIG.json"
LOCAL_TZ = ZoneInfo("Europe/Copenhagen")
DAILY_BASELINES = {}
ECON_CACHE = {"at": 0.0, "value": None}


def load_base_config():
    with CONFIG_PATH.open(encoding="utf-8-sig") as fh:
        return json.load(fh)


def normalize_token(raw):
    token = str(raw or "").lstrip("\ufeff").strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ("'", '"'):
        token = token[1:-1].strip()
    lowered = token.lower()
    if not token:
        return ""
    if any(text in lowered for text in ("indsæt", "indsaet", "long-lived access token", "langlivet adgangstoken")):
        raise RuntimeError("HA_TOKEN.txt indeholder hjælpetekst og ikke et rigtigt token")
    if any(char.isspace() for char in token):
        raise RuntimeError("HA_TOKEN.txt skal kun indeholde selve tokenet på én linje")
    return token


def load_config():
    config = load_base_config()
    token_file = ROOT / config.get("token_file", "HA_TOKEN.txt")
    token = os.environ.get("NECC_HA_TOKEN", "")
    if not token and token_file.exists():
        token = token_file.read_text(encoding="utf-8-sig")
    config["token"] = normalize_token(token)
    return config


def local_ip():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))
        return sock.getsockname()[0]
    except OSError:
        return ""
    finally:
        sock.close()


def ha_request(config, path):
    if not config["token"]:
        raise RuntimeError("HA_TOKEN.txt mangler")
    url = config["home_assistant_url"].rstrip("/") + path
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise RuntimeError("HA-token afvist") from exc
        raise RuntimeError(f"Home Assistant svarede HTTP {exc.code}") from exc
    except OSError as exc:
        raise RuntimeError("kan ikke kontakte Home Assistant") from exc


def ha_states(config):
    return ha_request(config, "/api/states")


def number(entity):
    if not entity:
        return None
    try:
        return float(str(entity.get("state", "")).replace(",", "."))
    except (TypeError, ValueError):
        return None


def pick(index, names):
    for name in names:
        if name and name in index and number(index[name]) is not None:
            return index[name], name
    return None, None


def pick_entity(index, names):
    for name in names:
        if name and name in index:
            return index[name], name
    return None, None


def unit_factor(entity, target):
    unit = str((entity or {}).get("attributes", {}).get("unit_of_measurement", "")).lower()
    if target == "W" and unit == "kw": return 1000
    if target == "kWh" and unit == "wh": return 0.001
    if target == "A" and unit == "ma": return 0.001
    return 1


def candidates(config, key, defaults):
    value = config.get("entities", {}).get(key, [])
    if isinstance(value, str): value = [value]
    return [*value, *defaults]


def direction_raw_state(entity):
    return str((entity or {}).get("state", ""))


def normalized_direction(entity):
    """Robust normalization of the P1 flow-direction sensor.

    Home Assistant normally exposes IMPORT/EXPORT.  Some entity/state paths may
    contain invisible Unicode/control characters, localized wording or a
    direction icon.  Normalize those without changing the source entity.
    """
    raw = direction_raw_state(entity)
    value = unicodedata.normalize("NFKC", raw).replace("\ufeff", "")
    value = "".join(ch for ch in value if not unicodedata.category(ch).startswith("C"))
    value = value.strip().upper()

    if value in ("IMPORT", "IMPORTING", "KØB", "KOEB") or value.startswith("IMPORT"):
        return "IMPORT"
    if value in ("EXPORT", "EXPORTING", "SALG") or value.startswith("EXPORT"):
        return "EXPORT"

    icon = str((entity or {}).get("attributes", {}).get("icon", "")).strip().lower()
    if "transmission-tower-import" in icon or icon.endswith("-import"):
        return "IMPORT"
    if "transmission-tower-export" in icon or icon.endswith("-export"):
        return "EXPORT"
    return None


def price_dkk_per_kwh(entity):
    value = number(entity)
    if value is None:
        return None
    unit = str((entity or {}).get("attributes", {}).get("unit_of_measurement", "")).lower()
    if "øre" in unit or "ore" in unit or "cent" in unit:
        value /= 100
    elif "mwh" in unit:
        value /= 1000
    return value


def parse_dt(row):
    raw = row.get("last_updated") or row.get("last_changed")
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(LOCAL_TZ)
    except Exception:
        return None


def history_rows(config, entity_id, start_local):
    if not entity_id:
        return []
    start = start_local.astimezone(timezone.utc).isoformat()
    query = urllib.parse.urlencode({"filter_entity_id": entity_id, "minimal_response": "", "no_attributes": ""})
    path = "/api/history/period/" + urllib.parse.quote(start, safe=":+-") + "?" + query
    try:
        groups = ha_request(config, path)
        return groups[0] if groups and isinstance(groups[0], list) else []
    except Exception:
        return []


def history_baseline(config, entity_id, current_value):
    if not entity_id or current_value is None:
        return None
    now_local = datetime.now(LOCAL_TZ)
    day_key = now_local.date().isoformat()
    cache_key = (entity_id, day_key)
    if cache_key in DAILY_BASELINES:
        return DAILY_BASELINES[cache_key]
    midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    rows = history_rows(config, entity_id, midnight - timedelta(minutes=1))
    baseline = current_value
    for row in rows:
        try:
            baseline = float(str(row.get("state", "")).replace(",", "."))
            break
        except (TypeError, ValueError):
            continue
    DAILY_BASELINES[cache_key] = baseline
    return baseline


def energy_today(config, entity, entity_id):
    current_raw = number(entity)
    if current_raw is None:
        return None
    baseline_raw = history_baseline(config, entity_id, current_raw)
    if baseline_raw is None:
        return None
    return max(0.0, (current_raw - baseline_raw) * unit_factor(entity, "kWh"))


def optimizer_price_config(config):
    env_path = os.environ.get("NECC_OPTIMIZER_CONFIG", "").strip()
    raw_candidates = ([env_path] if env_path else []) + list(config.get("optimizer_config_candidates", []))
    for raw in raw_candidates:
        try:
            path = Path(raw)
            if path.is_file():
                data = json.loads(path.read_text(encoding="utf-8-sig"))
                prices = data.get("prices")
                if isinstance(prices, dict):
                    return prices, str(path)
        except Exception:
            pass
    return dict(config.get("prices", {})), "LIVE_CONFIG.json · fallback"


def n1_tariff(prices, dt):
    table = prices.get("n1_tariffs_dkk_per_kwh_including_vat", {})
    summer_months = table.get("summer_months", [4,5,6,7,8,9])
    season = "summer" if dt.month in summer_months else "winter"
    period = "high"
    for name, ranges in prices.get("tariff_periods", {}).items():
        if any(int(start) <= dt.hour < int(end) for start, end in ranges):
            period = name
            break
    return float(table.get(season, {}).get(period, 0.0)), season, period


def spot_vat_included(price_entity, prices):
    mode = str(prices.get("buy_spot_vat_mode", "auto")).lower()
    if mode == "included": return True
    if mode == "excluded": return False
    attrs = (price_entity or {}).get("attributes", {})
    for key in ("VAT", "vat", "include_vat", "vat_included"):
        if key in attrs:
            value = attrs[key]
            if isinstance(value, bool): return value
            if str(value).lower() in ("true", "yes", "1", "on"): return True
            if str(value).lower() in ("false", "no", "0", "off"): return False
    eid = str((price_entity or {}).get("entity_id", ""))
    if eid.startswith("sensor.nord_pool_") and eid.endswith("_current_price"):
        return False
    return True


def price_breakdown(spot, price_entity, prices, dt):
    # Vindstød-fakturaerne opstiller de momspligtige købsposter ekskl. moms og
    # lægger moms på det samlede momspligtige beløb. Derfor normaliseres alle
    # købskomponenter til ekskl. moms først og moms vises samlet til sidst.
    vat_included = spot_vat_included(price_entity, prices)
    spot_ex_vat = spot / 1.25 if vat_included else spot

    n1_incl, season, period = n1_tariff(prices, dt)
    n1_ex = n1_incl / 1.25

    # Kontrakten angiver Vindstød-tillægget inkl. moms.
    supplier_incl = float(prices.get("supplier_markup_dkk_per_kwh", 0.0))
    supplier_ex = supplier_incl / 1.25

    # Elafgift og Energinet-variable poster er fakturalinjer før moms.
    tax_ex = float(prices.get("electricity_tax_dkk_per_kwh", 0.0))
    system_ex = float(prices.get("energinet_system_dkk_per_kwh", 0.0))
    grid_ex = float(prices.get("energinet_grid_dkk_per_kwh", 0.0))

    subtotal_ex = spot_ex_vat + supplier_ex + tax_ex + n1_ex + system_ex + grid_ex
    vat_total = subtotal_ex * 0.25
    total = subtotal_ex + vat_total

    sell_mode = str(prices.get("sell_spot_vat_mode", "excluded")).lower()
    if sell_mode in ("included", "same_as_buy"):
        sell_spot = spot_ex_vat * 1.25
    else:
        sell_spot = spot_ex_vat

    # Produktion er observeret med -0,0215 kr/kWh i flere Vindstød-afregninger.
    # Brug eksplicit P1-settlement override, så den gamle optimizer-værdi 0,04
    # ikke fejlagtigt bliver præsenteret som fakturavalideret salgsværdi.
    sell_deduction = float(prices.get("p1_sell_settlement_deduction_dkk_per_kwh", 0.0215))
    sell = sell_spot - sell_deduction
    return {
        "spotExVat": round(spot_ex_vat, 5),
        "vatTotal": round(vat_total, 5),
        "spotInclVat": round(spot_ex_vat * 1.25, 5),
        "supplierMarkup": round(supplier_ex, 5),
        "electricityTax": round(tax_ex, 5),
        "energinetSystem": round(system_ex, 5),
        "energinetGrid": round(grid_ex, 5),
        "n1Tariff": round(n1_ex, 5),
        "n1TariffInclVat": round(n1_incl, 5),
        "subtotalExVat": round(subtotal_ex, 5),
        "sellDeduction": round(sell_deduction, 5),
        "n1Season": season,
        "n1Period": period,
        "buyTotal": round(total, 5),
        "sellPrice": round(sell, 5),
    }


def state_points(rows, current_entity=None):
    points=[]
    for row in rows:
        try:
            val=float(str(row.get("state", "")).replace(",", "."))
        except (TypeError, ValueError):
            continue
        dt=parse_dt(row)
        if dt: points.append((dt,val))
    if current_entity and number(current_entity) is not None:
        dt=parse_dt(current_entity) or datetime.now(LOCAL_TZ)
        points.append((dt, number(current_entity)))
    points.sort(key=lambda x:x[0])
    dedup=[]
    for dt,val in points:
        if dedup and dt == dedup[-1][0]: dedup[-1]=(dt,val)
        else: dedup.append((dt,val))
    return dedup


def price_at(points, dt, fallback):
    value=fallback
    for pdt,pval in points:
        if pdt <= dt: value=pval
        else: break
    return value


def daily_economy(config, index, imp, imp_id, exp, exp_id, price, price_id, prices):
    now=time.time()
    if ECON_CACHE["value"] is not None and now-ECON_CACHE["at"] < 60:
        return ECON_CACHE["value"]
    midnight=datetime.now(LOCAL_TZ).replace(hour=0,minute=0,second=0,microsecond=0)
    start=midnight-timedelta(minutes=1)
    price_rows=history_rows(config, price_id, start)
    price_points=state_points(price_rows, price)
    current_spot=price_dkk_per_kwh(price)
    def calc(counter_entity,counter_id,kind):
        if not counter_entity or not counter_id: return 0.0
        rows=history_rows(config,counter_id,start)
        points=state_points(rows,counter_entity)
        total=0.0
        for (_,a),(dt,b) in zip(points,points[1:]):
            delta=max(0.0,(b-a)*unit_factor(counter_entity,"kWh"))
            if delta<=0: continue
            sp=price_at(price_points,dt,current_spot)
            if sp is None: continue
            br=price_breakdown(float(sp),price,prices,dt)
            total += delta * (br["buyTotal"] if kind=="buy" else br["sellPrice"])
        return total
    value={"buyCostToday":round(calc(imp,imp_id,"buy"),2),"sellRevenueToday":round(calc(exp,exp_id,"sell"),2)}
    value["netCostToday"]=round(value["buyCostToday"]-value["sellRevenueToday"],2)
    ECON_CACHE.update({"at":now,"value":value})
    return value


def live_payload():
    config=load_config()
    states=ha_states(config)
    index={item["entity_id"]:item for item in states}
    used={}
    total,used["power"]=pick(index,candidates(config,"power",["sensor.p1_meter_effekt","sensor.p1_meter_active_power","sensor.p1_meter_power"]))
    if not total:
        matches=[]
        for item in states:
            eid=item["entity_id"].lower(); label=str(item.get("attributes",{}).get("friendly_name","")).lower(); unit=str(item.get("attributes",{}).get("unit_of_measurement","")).lower()
            if ("p1" in eid or "p1" in label) and re.search(r"power|effekt",eid+" "+label) and unit in ("w","kw"):
                matches.append(item)
        if len(matches)==1: total,used["power"]=matches[0],matches[0]["entity_id"]
    if not total: raise RuntimeError("P1-effekt-entiteten blev ikke fundet; ret LIVE_CONFIG.json")

    direction_entity,used["direction"]=pick_entity(index,candidates(config,"direction",["sensor.niller_energy_engine_niller_energy_p1_status"]))
    direction=normalized_direction(direction_entity)
    imp,used["import"]=pick(index,candidates(config,"import_today",["sensor.p1_meter_energy_import"]))
    exp,used["export"]=pick(index,candidates(config,"export_today",["sensor.p1_meter_energy_export"]))
    price,used["price"]=pick(index,candidates(config,"price",["sensor.nord_pool_dk1_current_price"]))
    pv,used["pv_power"]=pick(index,candidates(config,"pv_power",["sensor.emma_pv_output_power"]))
    load,used["load_power"]=pick(index,candidates(config,"load_power",["sensor.emma_load_power"]))
    batt_soc,used["battery_soc"]=pick(index,candidates(config,"battery_soc",["sensor.emma_state_of_capacity"]))
    batt_power,used["battery_power"]=pick(index,candidates(config,"battery_power",["sensor.emma_battery_charge_discharge_power"]))

    phases=[]; phase_complete=True
    for phase in (1,2,3):
        p,used[f"l{phase}_power"]=pick(index,candidates(config,f"l{phase}_power",[]))
        a,used[f"l{phase}_current"]=pick(index,candidates(config,f"l{phase}_current",[]))
        v,used[f"l{phase}_voltage"]=pick(index,candidates(config,f"l{phase}_voltage",[]))
        if not p and not all((a,v)): phase_complete=False
        voltage=(number(v) or 230)*unit_factor(v,"V")
        current=(number(a)*unit_factor(a,"A")) if number(a) is not None else None
        power=number(p)*unit_factor(p,"W") if number(p) is not None else (current or 0)*voltage
        if current is None: current=abs(power)/voltage if voltage else 0
        phases.append({"name":f"L{phase}","powerW":round(power,2),"currentA":round(current,3),"voltageV":round(voltage,2)})

    raw_power=number(total)*unit_factor(total,"W")
    power=-abs(raw_power) if direction=="EXPORT" else abs(raw_power) if direction=="IMPORT" else raw_power
    spot=price_dkk_per_kwh(price)
    prices,price_source=optimizer_price_config(config)
    breakdown=price_breakdown(spot,price,prices,datetime.now(LOCAL_TZ)) if spot is not None else None
    econ=daily_economy(config,index,imp,used.get("import"),exp,used.get("export"),price,used.get("price"),prices) if price else {"buyCostToday":0.0,"sellRevenueToday":0.0,"netCostToday":0.0}
    quality_ok=phase_complete and direction is not None

    return {
        "ok":True,"source":"HOME_ASSISTANT_P1_EMMA","quality":"OK" if quality_ok else "PARTIAL",
        "timestamp":total.get("last_updated") or time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
        "powerW":round(power,2),"direction":direction,"directionRaw":direction_raw_state(direction_entity),"phases":phases,
        "importTodayKwh":energy_today(config,imp,used.get("import")),
        "exportTodayKwh":energy_today(config,exp,used.get("export")),
        "spotPrice":spot,
        "buyPrice":breakdown.get("buyTotal") if breakdown else None,
        "sellPrice":breakdown.get("sellPrice") if breakdown else None,
        "priceBreakdown":breakdown,
        "priceConfigSource":price_source,
        "buyCostToday":econ.get("buyCostToday"),"sellRevenueToday":econ.get("sellRevenueToday"),"netCostToday":econ.get("netCostToday"),
        "pvPowerW":round((number(pv) or 0)*unit_factor(pv,"W"),2) if pv else None,
        "housePowerW":round((number(load) or 0)*unit_factor(load,"W"),2) if load else None,
        "batterySoc":number(batt_soc),
        "batteryPowerW":round((number(batt_power) or 0)*unit_factor(batt_power,"W"),2) if batt_power else None,
        "entities":{k:v for k,v in used.items() if v}
    }


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # P1 VAGT udvikles lokalt på samme URL. Browser-cache må aldrig blande
        # frontendfiler fra 0.4 og 0.5.x.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?",1)[0]=="/api/live":
            try: payload,status=live_payload(),200
            except Exception as exc: payload,status={"ok":False,"error":str(exc)},503
            body=json.dumps(payload,ensure_ascii=False).encode("utf-8")
            self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Cache-Control","no-store"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body); return
        super().do_GET()


def serve_optional(port):
    try:
        server=ThreadingHTTPServer(("0.0.0.0",port),Handler)
        print(f"Ekstra adgang aktiv på port {port}")
        server.serve_forever()
    except OSError as exc:
        print(f"Port {port} kunne ikke åbnes ({exc}). Hovedserveren fortsætter.")


if __name__=="__main__":
    os.chdir(ROOT)
    config=load_base_config()
    port=int(config.get("server_port",8791)); mobile_port=int(config.get("mobile_port",8792))
    print(f"NECC P1 VAGT LIVE 0.5.3: http://localhost:{port}")
    lan_ip=local_ip()
    if lan_ip:
        print(f"Mobil på samme Wi-Fi: http://{lan_ip}:{port}")
        print(f"Mobil/Tailscale kompatibilitetsport: http://{lan_ip}:{mobile_port}")
    print("Home Assistant:",config.get("home_assistant_url"))
    print("Prisdata: NECC Optimizer config med sikker fallback")
    print("Luk dette vindue for at stoppe appen.")
    if mobile_port != port:
        threading.Thread(target=serve_optional,args=(mobile_port,),daemon=True).start()
    if os.environ.get("NECC_NO_BROWSER") != "1":
        threading.Timer(1.0,lambda:webbrowser.open(f"http://localhost:{port}")).start()
    ThreadingHTTPServer(("0.0.0.0",port),Handler).serve_forever()
