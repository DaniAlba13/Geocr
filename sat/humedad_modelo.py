"""Modelo propio de humedad del suelo por pieza, entrenado con NAX como "maestro" (preparación para reemplazar NAX).

Corre después de s2_piezas.py en el workflow sat-s2.yml.
  Etiquetas : moisture_percentage_ai de NAX por pieza y fecha (histórico del robot). Se acumulan entre corridas en
              sat/etiquetas/etiquetas_nax.csv (caché de GitHub), así el conjunto crece mientras siga el contrato.
  Variables : radar Sentinel-1 RTC (VV, VH en dB, VH−VV, órbita) de Microsoft Planetary Computer, la pasada más
              cercana ±3 días; NDVI y NDMI diarios propios (s2_diario.csv) y días a la última imagen limpia;
              edad de la caña (días desde start_date de NAX); día del año.
  Modelo    : HistGradientBoosting (scikit-learn).
  Validación: (a) piezas nunca vistas (GroupKFold por pieza), (b) fechas futuras (entrena con las primeras,
              prueba con las 2 últimas fechas de NAX). Se compara contra una línea base (promedio de la fecha).
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import s2_piezas as S  # noqa: E402

OUT, RAIZ = S.OUT, S.RAIZ
ETQ_DIR = os.path.join(S.AQUI, "etiquetas")
os.makedirs(ETQ_DIR, exist_ok=True)


def etiquetas():
    ruta = os.path.join(RAIZ, "nax", "historico_actual.csv")
    acum = os.path.join(ETQ_DIR, "etiquetas_nax.csv")
    old = pd.read_csv(acum, dtype={"id": str}) if os.path.exists(acum) else pd.DataFrame()
    new = pd.DataFrame()
    if os.path.exists(ruta):
        h = pd.read_csv(ruta, low_memory=False)
        if "product_name" in h.columns:
            h = h[h["product_name"].astype(str) == "moisture_percentage_ai"].copy()
            h["hum"] = pd.to_numeric(h["mean"], errors="coerce")
        else:
            h["hum"] = pd.to_numeric(h.get("moisture_percentage_ai"), errors="coerce")
        h["id"] = h["name"].astype(str).str.replace(r"\.0$", "", regex=True).str.zfill(11)
        h["fecha"] = h["timestamp"].astype(str).str.slice(0, 10)
        h["inicio"] = h["start_date"].astype(str).str.slice(0, 10) if "start_date" in h.columns else None
        new = h.dropna(subset=["hum"]).groupby(["id", "fecha"], as_index=False).agg(hum=("hum", "mean"), inicio=("inicio", "first"))
    E = pd.concat([old, new]).drop_duplicates(["id", "fecha"], keep="last")
    E.to_csv(acum, index=False)
    print(f"Etiquetas NAX: {len(E)} (nuevas en esta corrida {len(new)}), {E['id'].nunique() if len(E) else 0} piezas, "
          f"{E['fecha'].nunique() if len(E) else 0} fechas")
    return E


def radar(pzs, ini, fin):
    import planetary_computer as pc
    import rasterio
    from pystac_client import Client
    from pyproj import Transformer
    from rasterio.features import rasterize
    from rasterio.windows import from_bounds
    from shapely.geometry import mapping
    from shapely.ops import transform as shp_transform
    allb = [p.bounds for pp in pzs for p in pp["polys"]]
    bbox = (min(b[0] for b in allb), min(b[1] for b in allb), max(b[2] for b in allb), max(b[3] for b in allb))
    cat = Client.open("https://planetarycomputer.microsoft.com/api/stac/v1", modifier=pc.sign_inplace)
    items = list(cat.search(collections=["sentinel-1-rtc"], bbox=bbox, datetime=f"{ini}/{fin}").items())
    print(f"Sentinel-1 RTC: {len(items)} escenas")
    filas, cache = [], {}
    for it in sorted(items, key=lambda i: i.datetime):
        f = it.datetime.date().isoformat()
        try:
            arrs = {}
            for b in ("vv", "vh"):
                with rasterio.open(it.assets[b].href) as src:
                    bb = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True).transform_bounds(*bbox)
                    w = from_bounds(*bb, transform=src.transform).round_offsets().round_lengths()
                    arrs[b] = src.read(1, window=w, boundless=True, fill_value=0).astype("float32")
                    tr, crs = src.window_transform(w), src.crs
        except Exception as e:
            print(f"  {f}: no se pudo leer ({e})")
            continue
        shape = arrs["vv"].shape
        key = (str(crs), tuple(tr)[:6], shape)
        if key not in cache:
            to = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
            shp = [(mapping(shp_transform(to, pol).buffer(-10)), i + 1) for i, p in enumerate(pzs) for pol in p["polys"]
                   if not shp_transform(to, pol).buffer(-10).is_empty]
            cache[key] = rasterize(shp, out_shape=shape, transform=tr, fill=0, dtype="int32")
        lab = cache[key]
        ok = (arrs["vv"] > 0) & (arrs["vh"] > 0)
        L = np.where(ok, lab, 0).ravel()
        n = np.bincount(L, minlength=len(pzs) + 1)
        sv = np.bincount(L, weights=arrs["vv"].ravel() * (L > 0), minlength=len(pzs) + 1)
        sh = np.bincount(L, weights=arrs["vh"].ravel() * (L > 0), minlength=len(pzs) + 1)
        orb = 1 if str(it.properties.get("sat:orbit_state", "")).startswith("asc") else 0
        k = 0
        for i, p in enumerate(pzs):
            j = i + 1
            if n[j] < 5:
                continue
            vv, vh = sv[j] / n[j], sh[j] / n[j]
            filas.append({"id": p["id"], "fecha_s1": f, "vv_db": 10 * np.log10(vv), "vh_db": 10 * np.log10(vh), "asc": orb})
            k += 1
        print(f"  {f} {'asc' if orb else 'desc'}: {k} piezas")
    return pd.DataFrame(filas)


def main():
    E = etiquetas()
    if len(E) < 200:
        sys.exit("Muy pocas etiquetas de NAX para entrenar todavía.")
    pzs = S.piezas()
    ids = {p["id"] for p in pzs}
    E = E[E["id"].isin(ids)].copy()
    ini = (pd.to_datetime(E["fecha"].min()) - pd.Timedelta(days=4)).date()
    fin = pd.Timestamp.today().date()
    R = radar(pzs, ini, fin)
    if R.empty:
        sys.exit("Sin radar.")
    R["vh_vv"] = R["vh_db"] - R["vv_db"]
    R.to_csv(os.path.join(OUT, "s1_piezas.csv"), index=False)
    # unir: radar más cercano ±3 días
    E["t"] = pd.to_datetime(E["fecha"]).astype("datetime64[ns]")
    R["t"] = pd.to_datetime(R["fecha_s1"]).astype("datetime64[ns]")
    X = pd.merge_asof(E.sort_values("t"), R.sort_values("t"), on="t", by="id", tolerance=pd.Timedelta(days=3), direction="nearest")
    X["dias_s1"] = (X["t"] - pd.to_datetime(X["fecha_s1"])).dt.days.abs()
    D = pd.read_csv(os.path.join(OUT, "s2_diario.csv"), dtype={"id": str})
    X = X.merge(D[["id", "fecha", "ndvi", "ndmi", "dias_a_obs"]], on=["id", "fecha"], how="left")
    X["edad"] = (X["t"] - pd.to_datetime(X["inicio"], errors="coerce")).dt.days
    X["doy"] = X["t"].dt.dayofyear
    F = ["vv_db", "vh_db", "vh_vv", "asc", "dias_s1", "ndvi", "ndmi", "dias_a_obs", "edad", "doy"]
    X = X.dropna(subset=["hum"])
    print(f"Tabla de entrenamiento: {len(X)} filas · con radar {X['vv_db'].notna().sum()} · con Sentinel-2 {X['ndvi'].notna().sum()}")

    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.inspection import permutation_importance
    from sklearn.model_selection import GroupKFold

    def met(y, p):
        e = p - y
        return {"n": int(len(y)), "r": round(float(np.corrcoef(y, p)[0, 1]), 3), "rmse": round(float(np.sqrt((e ** 2).mean())), 3),
                "mae": round(float(np.abs(e).mean()), 3)}
    mk = lambda: HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, max_leaf_nodes=31, l2_regularization=1.0, random_state=7)
    y = X["hum"].values
    # (a) piezas nunca vistas
    pred = np.full(len(X), np.nan)
    for tr, te in GroupKFold(n_splits=5).split(X, y, X["id"]):
        m = mk().fit(X.iloc[tr][F], y[tr]); pred[te] = m.predict(X.iloc[te][F])
    base = X.groupby("fecha")["hum"].transform("mean").values
    res = {"piezas_nuevas": met(y, pred), "linea_base_promedio_fecha": met(y, base)}
    # (b) fechas futuras
    fs = sorted(X["fecha"].unique())
    if len(fs) >= 5:
        te = X["fecha"].isin(fs[-2:]); trn = ~te
        m = mk().fit(X[trn][F], y[trn.values]); p2 = m.predict(X[te][F])
        res["fechas_futuras"] = {**met(y[te.values], p2), "fechas_prueba": fs[-2:]}
        res["linea_base_fechas_futuras"] = met(y[te.values], np.full(te.sum(), y[trn.values].mean()))
    m = mk().fit(X[F], y)
    imp = permutation_importance(m, X[F], y, n_repeats=5, random_state=7)
    res["importancia"] = {f: round(float(v), 3) for f, v in sorted(zip(F, imp.importances_mean), key=lambda a: -a[1])}
    res["etiquetas"] = int(len(X)); res["piezas"] = int(X["id"].nunique()); res["fechas"] = len(fs)
    json.dump(res, open(os.path.join(OUT, "modelo_humedad.json"), "w"), indent=1, ensure_ascii=False)
    print("MODELO_HUMEDAD", json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
