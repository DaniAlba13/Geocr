"""Clima diario por división para el balance hídrico de AgroAP-CR.

Corre en el robot diario (GitHub Actions), después de la descarga de NAX:
  1) NASA POWER (comunidad AG, sin clave): temperatura máx./mín., humedad relativa, viento a 2 m,
     radiación solar y lluvia (IMERG) para el centro de cada división. Con eso calcula la ETo
     FAO-56 Penman-Monteith (Allen et al., 1998, ec. 6). NASA llega con 2–3 días de atraso
     (radiación 5–7 días): los días sin radiación quedan sin ETo.
  2) NAX: promedio por división y día (ponderado por área efectiva) de los productos de agua que
     trae el histórico: humedad del suelo, contenido de agua, necesidad de riego, evapotranspiración
     y agua disponible (los que existan en la campaña).
  3) Publica en GeoCR: colección clima_nasa (un documento por fecha) y clima_nax (un documento por
     fecha con imagen). La plataforma cruza las fuentes, mide la correlación y calibra el balance.
"""
import math
import os
import sys
import time
from datetime import date, timedelta

import pandas as pd
import requests

AQUI = os.path.dirname(os.path.abspath(__file__))
DIVS = {  # centro de cada división (lat, lon), de la capa de divisiones de la plataforma
    "Baigua": (18.5505, -68.6411), "Cuyá": (18.4850, -68.7870), "Chavón Abajo": (18.4997, -68.9144),
    "Higueral": (18.5132, -69.0133), "La Higuera": (18.7183, -69.0683), "Guaymate": (18.6271, -68.9742),
    "Lechugas": (18.6000, -69.0950)}
DIVN = {1: "Higueral", 2: "Guaymate", 3: "La Higuera", 4: "Chavón Abajo", 5: "Cuyá", 6: "Lechugas", 7: "Baigua"}
ELEV = 40.0          # m s. n. m. aproximados de la llanura cañera (solo afecta la presión atmosférica)
DIAS = int(os.environ.get("CLIMA_DIAS") or 150)
PARAMS = "T2M_MAX,T2M_MIN,RH2M,WS2M,ALLSKY_SFC_SW_DWN,PRECTOTCORR"


def eto_fao56(tmax, tmin, rh, u2, rs, lat, doy, z=ELEV):
    """ETo diaria (mm) FAO-56 Penman-Monteith con Rs en MJ m-2 d-1."""
    t = (tmax + tmin) / 2
    e0 = lambda x: 0.6108 * math.exp(17.27 * x / (x + 237.3))
    es = (e0(tmax) + e0(tmin)) / 2
    ea = es * rh / 100
    delta = 4098 * e0(t) / (t + 237.3) ** 2
    p = 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26
    gam = 0.000665 * p
    phi = math.radians(lat)
    dr = 1 + 0.033 * math.cos(2 * math.pi * doy / 365)
    dec = 0.409 * math.sin(2 * math.pi * doy / 365 - 1.39)
    ws = math.acos(max(-1.0, min(1.0, -math.tan(phi) * math.tan(dec))))
    ra = 24 * 60 / math.pi * 0.082 * dr * (ws * math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.sin(ws))
    rso = (0.75 + 2e-5 * z) * ra
    rns = 0.77 * rs
    rnl = 4.903e-9 * ((tmax + 273.16) ** 4 + (tmin + 273.16) ** 4) / 2 * (0.34 - 0.14 * math.sqrt(max(ea, 0))) \
        * (1.35 * min(rs / rso, 1.0) - 0.35)
    rn = rns - rnl
    return max(0.0, (0.408 * delta * rn + gam * 900 / (t + 273) * u2 * (es - ea)) / (delta + gam * (1 + 0.34 * u2)))


def nasa(lat, lon, ini, fin):
    u = "https://power.larc.nasa.gov/api/temporal/daily/point"
    q = dict(parameters=PARAMS, community="AG", latitude=lat, longitude=lon,
             start=ini.strftime("%Y%m%d"), end=fin.strftime("%Y%m%d"), format="JSON", **{"time-standard": "LST"})
    for intento in range(3):
        try:
            r = requests.get(u, params=q, timeout=90)
            if r.ok:
                return r.json()["properties"]["parameter"]
            print(f"  NASA respondió {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"  NASA no respondió ({e})")
        time.sleep(5 * (intento + 1))
    return None


def serie_nasa():
    fin, ini = date.today(), date.today() - timedelta(days=DIAS)
    out = {}
    for dv, (lat, lon) in DIVS.items():
        P = nasa(lat, lon, ini, fin)
        if not P:
            print(f"NASA POWER: sin datos para {dv}")
            continue
        n_eto = 0
        for k in P["T2M_MAX"]:
            f = f"{k[:4]}-{k[4:6]}-{k[6:]}"
            v = {c: P[c].get(k) for c in P}
            v = {c: (None if x is None or x <= -998 else float(x)) for c, x in v.items()}
            d = {"tmax": v["T2M_MAX"], "tmin": v["T2M_MIN"], "rh": v["RH2M"], "u2": v["WS2M"], "rs": v["ALLSKY_SFC_SW_DWN"],
                 "p": v["PRECTOTCORR"]}
            if None not in (d["tmax"], d["tmin"], d["rh"], d["u2"], d["rs"]):
                doy = date(int(k[:4]), int(k[4:6]), int(k[6:])).timetuple().tm_yday
                d["eto"] = round(eto_fao56(d["tmax"], d["tmin"], d["rh"], d["u2"], d["rs"], lat, doy), 2)
                n_eto += 1
            d = {c: (round(x, 2) if isinstance(x, float) else x) for c, x in d.items() if x is not None}
            if d:
                out.setdefault(f, {})[dv] = d
        print(f"NASA POWER {dv}: {len(P['T2M_MAX'])} días, {n_eto} con ETo")
    return out


def _div(v):
    try:
        return DIVN.get(int(float(v)))
    except (TypeError, ValueError):
        import unicodedata
        n = lambda x: unicodedata.normalize("NFD", str(x)).encode("ascii", "ignore").decode().strip().lower()
        t = n(v)
        return next((k for k in DIVS if n(k) == t or t.endswith(n(k))), None)


def serie_nax():
    ruta = os.path.join(AQUI, "historico_actual.csv")
    if not os.path.exists(ruta):
        return {}
    d = pd.read_csv(ruta, low_memory=False)
    # Formato largo (una fila por producto: product_name + mean): se pasa a una columna por producto.
    if "product_name" in d.columns and "mean" in d.columns:
        base = [c for c in ("name", "timestamp", "grouping_unit_02", "effective_area") if c in d.columns]
        d["_v"] = pd.to_numeric(d["mean"], errors="coerce")
        d = d.dropna(subset=["_v"]).pivot_table(index=base, columns="product_name", values="_v", aggfunc="mean").reset_index()
        d.columns = [str(c) for c in d.columns]
        print("NAX (formato largo), productos:", [c for c in d.columns if c not in base])
    cols = {c: c.lower() for c in d.columns}
    num = lambda c: pd.to_numeric(d[c], errors="coerce")
    def elegir(*claves, excluir=("optimal", "evolution", "median", "anomal")):
        cand = [c for c, l in cols.items() if any(k in l for k in claves) and not any(x in l for x in excluir)]
        return max(cand, key=lambda c: num(c).notna().sum()) if cand else None
    V = {"hum": elegir("moisture_percentage_ai") or elegir("moisture", "humid"), "wc": elegir("water_content"), "ins": elegir("irrigation_need"),
         "et": elegir("evapotrans"), "aw": elegir("available_water")}
    V = {k: c for k, c in V.items() if c}
    print("NAX, columnas de agua usadas:", V)
    if not V or "timestamp" not in d.columns or ("grouping_unit_02" not in d.columns and "name" not in d.columns):
        return {}
    d["_f"] = d["timestamp"].astype(str).str.slice(0, 10)
    # División: del ID de la pieza (ADM + DIV + DISTRITO + TABLÓN + PIEZA, 11 dígitos) y, si no, de grouping_unit_02.
    def _div_id(v):
        t = str(v or "").strip()
        if t.endswith(".0"):
            t = t[:-2]
        return DIVN.get(int(t.zfill(11)[1])) if t.isdigit() and len(t) <= 11 else None
    d["_d"] = d["name"].map(_div_id) if "name" in d.columns else None
    if "grouping_unit_02" in d.columns:
        d["_d"] = d["_d"].fillna(d["grouping_unit_02"].map(_div)) if d["_d"] is not None else d["grouping_unit_02"].map(_div)
    d["_w"] = (pd.to_numeric(d["effective_area"], errors="coerce") if "effective_area" in d.columns else pd.Series(1.0, index=d.index)).fillna(1.0).clip(lower=0.01)
    out = {}
    for (f, dv), g in d[d["_d"].notna()].groupby(["_f", "_d"]):
        o = {}
        for k, c in V.items():
            x = pd.to_numeric(g[c], errors="coerce")
            m = x.notna()
            if m.sum():
                o[k] = round(float((x[m] * g["_w"][m]).sum() / g["_w"][m].sum()), 3)
        if o:
            o["n"] = int(len(g))
            out.setdefault(f, {})[dv] = o
    print(f"NAX: {len(out)} fechas con imagen")
    return out


def publicar(coll, serie):
    url, tok = (os.environ.get("GEOCR_URL") or "").rstrip("/"), (os.environ.get("GEOCR_INGEST_TOKEN") or "").strip()
    if not url or not tok:
        print("Sin GEOCR_URL / GEOCR_INGEST_TOKEN: no se publica.")
        return
    ops = [{"op": "set", "coll": coll, "id": "d" + f.replace("-", ""), "data": {"fecha": f, "divs": v}} for f, v in sorted(serie.items())]
    for i in range(0, len(ops), 40):
        r = requests.post(url + "/api/ingest", json={"ops": ops[i:i + 40]}, timeout=60, allow_redirects=False,
                          headers={"authorization": "Bearer " + tok})
        if r.status_code >= 300:
            sys.exit(f"GeoCR respondió {r.status_code} al publicar {coll}: {r.text[:200]}")
    print(f"Publicado {coll}: {len(ops)} fechas.")


if __name__ == "__main__":
    n = serie_nasa()
    x = serie_nax()
    if "--solo-probar" in sys.argv:
        print({k: n[k] for k in sorted(n)[-3:]})
        print({k: x[k] for k in sorted(x)[-3:]})
        sys.exit(0)
    publicar("clima_nasa", n)
    publicar("clima_nax", x)
