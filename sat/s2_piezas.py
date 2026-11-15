"""Prueba de concepto: índices Sentinel-2 por pieza, con relleno de nubes y validación (reemplazo de NAX).

Corre en GitHub Actions (workflow sat-s2.yml). Datos: Sentinel-2 L2A Collection 1 (reflectancia de superficie,
armonizada) del catálogo abierto Earth Search en AWS; sin cuenta, licencia Copernicus (uso comercial permitido
citando la fuente).

Pasos:
  1. Busca todas las escenas de la división en el período.
  2. Por escena: lee rojo, NIR (10 m), borde rojo 1 y SWIR 1.6 (20 m) y la clasificación de escena (SCL).
     Enmascara nubes, sombras, cirros y nieve (SCL distinto de vegetación o suelo desnudo).
  3. Por pieza (polígono reducido 10 m hacia adentro, para evitar bordes y caminos): media de NDVI, NDRE y NDMI
     de los píxeles válidos. La fecha cuenta solo si al menos 60 % de la pieza está despejada.
  4. Relleno de fechas nubladas: suavizado de Whittaker ponderado sobre la serie diaria de cada pieza.
  5. Validación: se ocultan 20 % de las observaciones reales, se reconstruyen y se mide el error según
     cuántos días hay hasta la observación más cercana. Así cada dato reconstruido lleva su error esperado.
  6. Si está el histórico de NAX (caché del robot), compara NDVI de Sentinel-2 contra NDVI de NAX en las
     mismas piezas y fechas.

Salidas en sat/salida/: s2_observado.csv, s2_diario.csv, validacion.json, comparacion_nax.csv, resumen.png
"""
import json
import os
import sys
from datetime import date, timedelta

import numpy as np
import pandas as pd
import rasterio
from pystac_client import Client
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from shapely.geometry import Polygon, mapping
from shapely.ops import transform as shp_transform
from scipy import sparse
from scipy.sparse.linalg import spsolve

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
OUT = os.path.join(AQUI, "salida")
os.makedirs(OUT, exist_ok=True)
DIVN = {1: "Higueral", 2: "Guaymate", 3: "La Higuera", 4: "Chavón Abajo", 5: "Cuyá", 6: "Lechugas", 7: "Baigua"}
DIV = int(os.environ.get("DIVISION") or 1)
DIAS = int(os.environ.get("DIAS") or 240)
MIN_DESPEJADO = 0.6
VALIDO_SCL = {4, 5}          # 4 vegetación, 5 suelo desnudo
LAMBDA = float(os.environ.get("LAMBDA") or 50)
os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")


def piezas():
    P = json.load(open(os.path.join(RAIZ, "src", "pieces.json")))
    A = json.load(open(os.path.join(RAIZ, "src", "attrs.json")))
    g = {}
    for r in P:
        if len(r) < 5 or r[0] != DIV or r[4] is None:
            continue
        div, tab, pz, ring, ri = r[:5]
        g.setdefault(ri, {"tab": str(tab), "pz": pz, "rings": []})["rings"].append(ring)
    out = []
    for ri, o in g.items():
        pid = str(A["rec"][ri][0]).zfill(11)
        out.append({"id": pid, "tab": o["tab"], "pz": o["pz"], "polys": [Polygon(r) for r in o["rings"] if len(r) >= 4]})
    return out


def whittaker(y, w, lam=LAMBDA, d=2):
    """Suavizado de Whittaker ponderado (Eilers 2003): min Σ w(y−z)² + λ Σ (Δ^d z)²."""
    n = len(y)
    D = sparse.eye(n, format="csc")
    for _ in range(d):
        D = D[1:] - D[:-1]
    W = sparse.diags(w)
    return spsolve((W + lam * D.T @ D).tocsc(), w * np.nan_to_num(y))


def leer(item, asset, win_bounds, crs, shape):
    a = item.assets[asset]
    with rasterio.open(a.href) as src:
        b = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True).transform_bounds(*win_bounds)
        w = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
        arr = src.read(1, window=w, out_shape=shape, resampling=Resampling.nearest if asset == "scl" else Resampling.bilinear,
                       boundless=True, fill_value=0)
        tr = src.window_transform(w)
        sc = (a.extra_fields.get("raster:bands") or [{}])[0]
        if asset != "scl":
            arr = arr.astype("float32") * sc.get("scale", 1e-4) + sc.get("offset", 0.0)
        return arr, tr, src.crs


def main():
    pzs = piezas()
    allb = [p.bounds for pp in pzs for p in pp["polys"]]
    bbox = (min(b[0] for b in allb), min(b[1] for b in allb), max(b[2] for b in allb), max(b[3] for b in allb))
    fin, ini = date.today(), date.today() - timedelta(days=DIAS)
    print(f"División {DIVN[DIV]}: {len(pzs)} piezas · bbox {bbox} · {ini} a {fin}")
    cat = Client.open("https://earth-search.aws.element84.com/v1")
    items = list(cat.search(collections=["sentinel-2-c1-l2a"], bbox=bbox, datetime=f"{ini}/{fin}",
                            query={"eo:cloud_cover": {"lt": 95}}).items())
    print(f"Escenas encontradas: {len(items)}")
    filas = []
    cache = {}
    for k, it in enumerate(sorted(items, key=lambda i: i.datetime)):
        f = it.datetime.date().isoformat()
        try:
            with rasterio.open(it.assets["red"].href) as src:
                crs = src.crs
                b = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform_bounds(*bbox)
                w = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
                shape = (int(w.height), int(w.width))
            red, tr, _ = leer(it, "red", bbox, crs, shape)
            nir, _, _ = leer(it, "nir", bbox, crs, shape)
            re1, _, _ = leer(it, "rededge1", bbox, crs, shape)
            sw1, _, _ = leer(it, "swir16", bbox, crs, shape)
            scl, _, _ = leer(it, "scl", bbox, crs, shape)
        except Exception as e:
            print(f"  {f} {it.id}: no se pudo leer ({e})")
            continue
        key = (str(crs), tuple(tr)[:6], shape)
        if key not in cache:   # etiquetas de pieza en la grilla de esta proyección
            to = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
            shapes = []
            for i, p in enumerate(pzs):
                for pol in p["polys"]:
                    g = shp_transform(to, pol).buffer(-10)
                    if not g.is_empty:
                        shapes.append((mapping(g), i + 1))
            lab = rasterize(shapes, out_shape=shape, transform=tr, fill=0, dtype="int32") if shapes else np.zeros(shape, "int32")
            tot = np.bincount(lab.ravel(), minlength=len(pzs) + 1)
            cache[key] = (lab, tot)
        lab, tot = cache[key]
        ok = np.isin(scl, list(VALIDO_SCL)) & (red > 0) & (nir > 0)
        with np.errstate(divide="ignore", invalid="ignore"):
            ndvi = (nir - red) / (nir + red)
            ndre = (nir - re1) / (nir + re1)
            ndmi = (nir - sw1) / (nir + sw1)
        L = np.where(ok, lab, 0).ravel()
        nv = np.bincount(L, minlength=len(pzs) + 1)
        s = {n: np.bincount(L, weights=np.nan_to_num(v.ravel()) * (L > 0), minlength=len(pzs) + 1) for n, v in
             (("ndvi", ndvi), ("ndre", ndre), ("ndmi", ndmi))}
        n_ok = 0
        for i, p in enumerate(pzs):
            j = i + 1
            if tot[j] < 5 or nv[j] / tot[j] < MIN_DESPEJADO:
                continue
            filas.append({"id": p["id"], "tab": p["tab"], "pz": p["pz"], "fecha": f, "despejado": round(nv[j] / tot[j], 3),
                          **{n: round(float(s[n][j] / nv[j]), 4) for n in s}})
            n_ok += 1
        print(f"  {f} {it.id} nubes {it.properties.get('eo:cloud_cover', 0):.0f} % · piezas despejadas {n_ok}/{len(pzs)}")
    obs = pd.DataFrame(filas)
    if obs.empty:
        sys.exit("Ninguna pieza despejada en el período.")
    obs = obs.groupby(["id", "tab", "pz", "fecha"], as_index=False).agg(
        {"despejado": "max", "ndvi": "mean", "ndre": "mean", "ndmi": "mean"})
    obs.to_csv(os.path.join(OUT, "s2_observado.csv"), index=False)

    # ---- relleno de nubes + validación ----
    rng = np.random.default_rng(7)
    dias = pd.date_range(ini, fin, freq="D")
    idx = {d.date().isoformat(): i for i, d in enumerate(dias)}
    diario, val = [], []
    for pid, g in obs.groupby("id"):
        y = np.full(len(dias), np.nan)
        for f, v in zip(g["fecha"], g["ndvi"]):
            y[idx[f]] = v
        ob = np.where(~np.isnan(y))[0]
        if len(ob) < 4:
            continue
        w = (~np.isnan(y)).astype(float)
        z = whittaker(y, w)
        # validación: ocultar 20 % de las observaciones y reconstruirlas
        hide = rng.choice(ob, size=max(1, len(ob) // 5), replace=False)
        w2 = w.copy(); w2[hide] = 0
        z2 = whittaker(y, w2)
        rest = np.setdiff1d(ob, hide)
        for h in hide:
            gap = int(np.min(np.abs(rest - h))) if len(rest) else 999
            val.append({"id": pid, "gap": gap, "real": y[h], "est": z2[h]})
        dist = np.array([int(np.min(np.abs(ob - i))) for i in range(len(dias))])
        for i in range(len(dias)):
            diario.append({"id": pid, "fecha": dias[i].date().isoformat(), "ndvi": round(float(z[i]), 4),
                           "observado": bool(w[i]), "dias_a_obs": int(dist[i])})
    D = pd.DataFrame(diario)
    V = pd.DataFrame(val)
    V["err"] = V["est"] - V["real"]
    tramos = [(0, 5), (6, 10), (11, 20), (21, 40), (41, 999)]
    res = []
    for a, b in tramos:
        m = V[(V.gap >= a) & (V.gap <= b)]
        if len(m):
            res.append({"dias_a_obs": f"{a}-{b if b < 999 else '+'}", "n": int(len(m)), "rmse": round(float(np.sqrt((m.err ** 2).mean())), 4),
                        "sesgo": round(float(m.err.mean()), 4), "r": round(float(np.corrcoef(m.real, m.est)[0, 1]), 3) if len(m) > 2 else None})
    err_por = {r["dias_a_obs"]: r["rmse"] for r in res}
    def unc(d):
        for (a, b) in tramos:
            if a <= d <= b:
                return err_por.get(f"{a}-{b if b < 999 else '+'}")
    D["error_esperado"] = D["dias_a_obs"].map(unc)
    D.to_csv(os.path.join(OUT, "s2_diario.csv"), index=False)

    # ---- comparación con NAX ----
    comp = None
    ruta = os.path.join(RAIZ, "nax", "historico_actual.csv")
    if os.path.exists(ruta):
        h = pd.read_csv(ruta, low_memory=False)
        col = next((c for c in h.columns if c.lower() == "ndvi_optical"), None) or next((c for c in h.columns if "ndvi" in c.lower()), None)
        if col and "name" in h.columns:
            h["id"] = h["name"].astype(str).str.replace(r"\.0$", "", regex=True).str.zfill(11)
            h["fecha"] = h["timestamp"].astype(str).str.slice(0, 10)
            h["nax"] = pd.to_numeric(h[col], errors="coerce")
            h = h.dropna(subset=["nax"]).groupby(["id", "fecha"], as_index=False)["nax"].mean()
            m = obs.merge(h, on=["id", "fecha"])
            if len(m) > 2:
                e = m["ndvi"] - m["nax"]
                comp = {"n": int(len(m)), "piezas": int(m["id"].nunique()), "fechas": int(m["fecha"].nunique()), "columna_nax": col,
                        "r": round(float(np.corrcoef(m.ndvi, m.nax)[0, 1]), 3), "sesgo_s2_menos_nax": round(float(e.mean()), 4),
                        "rmse": round(float(np.sqrt((e ** 2).mean())), 4)}
                m.to_csv(os.path.join(OUT, "comparacion_nax.csv"), index=False)
    resumen = {"division": DIVN[DIV], "desde": str(ini), "hasta": str(fin), "escenas": len(items), "piezas": len(pzs),
               "piezas_con_serie": int(D["id"].nunique()) if len(D) else 0, "observaciones": int(len(obs)),
               "obs_por_pieza_mediana": float(obs.groupby("id").size().median()),
               "validacion_relleno": res, "comparacion_nax": comp, "lambda": LAMBDA}
    json.dump(resumen, open(os.path.join(OUT, "validacion.json"), "w"), ensure_ascii=False, indent=1)
    print(json.dumps(resumen, ensure_ascii=False, indent=1))

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(1, 3, figsize=(16, 4.6))
        top = obs.groupby("id").size().sort_values(ascending=False).index[:3]
        for pid in top:
            d = D[D.id == pid]; o = obs[obs.id == pid]
            ax[0].plot(pd.to_datetime(d.fecha), d.ndvi, lw=1.5)
            ax[0].scatter(pd.to_datetime(o.fecha), o.ndvi, s=12)
        ax[0].set_title("NDVI diario reconstruido (línea) y observado (puntos)")
        ax[1].bar([r["dias_a_obs"] for r in res], [r["rmse"] for r in res], color="#0E2A47")
        ax[1].set_title("Error del relleno (RMSE NDVI) según días a la obs. más cercana")
        if comp:
            mm = pd.read_csv(os.path.join(OUT, "comparacion_nax.csv"))
            ax[2].scatter(mm.nax, mm.ndvi, s=6, alpha=.4, color="#0070C9"); lo, hi = mm[["nax", "ndvi"]].min().min(), mm[["nax", "ndvi"]].max().max()
            ax[2].plot([lo, hi], [lo, hi], "r--", lw=1); ax[2].set_xlabel("NDVI NAX"); ax[2].set_ylabel("NDVI Sentinel-2 propio")
            ax[2].set_title(f"Propio vs NAX · r={comp['r']} · RMSE={comp['rmse']}")
        fig.tight_layout(); fig.savefig(os.path.join(OUT, "resumen.png"), dpi=110)
    except Exception as e:
        print("Sin gráfico:", e)


if __name__ == "__main__":
    main()
