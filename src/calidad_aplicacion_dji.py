# -*- coding: utf-8 -*-
"""
CALIDAD DE APLICACION CON DRONE A PARTIR DEL KML DE VUELO
Central Romana Corporation - Area de Agricultura de Precision

USO
  1. Poner este script en la carpeta con los datos de la aplicacion:
       - los KML de "Flight track" del drone (sueltos, en subcarpetas o dentro de .zip / .kmz),
         de uno o de varios grupos de aplicacion / campos
       - el o los shapefiles de tablones y piezas (sueltos o en .zip). Puede ser un shapefile con
         muchos tablones: solo se evaluan los que recibieron aplicacion. No hay limite de tablones.
  2. Abrir PowerShell en esa carpeta y ejecutar:
       python calidad_aplicacion_dji.py
  3. Los resultados quedan en la carpeta  Calidad_Aplicacion_<fecha de aplicacion>

QUE HACE
  El KML del drone no trae caudal punto a punto: trae la linea de vuelo (vertices) y, por vuelo,
  altura, ancho de faja (Route Spacing), velocidad, area de tarea y ml asperjados.
  Con eso el script:
    a) separa las PASADAS DE APLICACION (paralelas al rumbo de trabajo) de los TRASLADOS;
    b) agrupa las piezas del shapefile por tablon y detecta que tablones fueron aplicados;
    c) en cada tablon genera la faja de aspersion de cada pasada sobre una malla fina y cuenta
       cuantas veces se cubrio cada celda -> aplicado / sobreaplicado / no aplicado / calles / fuera;
    d) reparte los litros de cada vuelo sobre su area barrida -> mapa de dosis, uniformidad y CV;
    e) genera el informe PDF (resumen ejecutivo, ficha por tablon, operacion, dosis, vuelos),
       CSV por tablon, pieza y vuelo, y capas para QGIS/ArcGIS (rasters .asc y GeoJSON).

Requisitos: Python 3.8+, numpy y matplotlib (nada mas).
"""

import os
import re
import io
import sys
import csv
import json
import math
import glob
import struct
import zipfile
import datetime as dt

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.path import Path as MplPath
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.colors import ListedColormap, BoundaryNorm
from matplotlib.patches import Patch

# =====================================================================================
# CONFIGURACION (cambiar aqui si hace falta)
# =====================================================================================
DOSIS_OBJETIVO = None         # dosis teorica en L por UNIDAD_AREA (ej. 6.2 L/ac). None = usa la dosis
                              # promedio real como referencia para la uniformidad.
UNIDAD_AREA = "ac"            # "ac" (acres) o "ha"
ANCHO_FAJA_M = None           # None = usa "Route Spacing" de cada KML; o fijar un valor en metros
RESOLUCION_M = 0.5            # tamano de celda de la malla de analisis (m)
TOLERANCIA_ANGULO = 3.0       # grados: una linea es "pasada" si es paralela al rumbo de trabajo +- esto
TOLERANCIA_DOSIS = 10.0       # %: rango +- para considerar la dosis "en objetivo"
FRANJA_MINIMA_M = 0.0         # ignorar fallas / traslapes mas angostos que esto (m), p.ej. 1.0 para
                              # no contar franjitas por variacion GPS. 0 = reportar todo tal cual.
DIST_CALLES_M = 15.0          # huecos entre piezas mas angostos que 2x esto se consideran calles
CAMPO_TABLON = None           # campo del shapefile que identifica el tablon. None = automatico (TAB, TABLON...)
UMBRAL_TABLON_PCT = 5.0       # % minimo de area aplicada para incluir un tablon en el informe (descarta
                              # tablones vecinos que solo rozan las fajas). No hay limite de tablones.
MARGEN_FAJA_M = 0.5           # variacion del ancho efectivo de faja (m, +-) usada para calcular el margen de
                              # incertidumbre de los resultados (GPS, viento, deriva, altura). 0 = sin margen
CAMPO_DOSIS_PRESCRIPCION = None  # campo de dosis del shapefile de prescripcion (tasa variada). None = automatico
                              # (busca DOSIS, DOSE, RATE o TASA). Sin shapefile de prescripcion = dosis fija.
UNIDAD_PRESCRIPCION = "L/ha"  # unidad del campo de dosis de la prescripcion: "L/ha" o "L/ac"
SUAVIZADO_M = 0.0             # sigma (m) de suavizado gaussiano del mapa de dosis (deriva / perfil
                              # lateral de la faja). 0 = faja uniforme, sin suavizado.

# Colores institucionales Central Romana
CR_MARINO = "#0b2a55"   # titulos / banda
CR_AZUL = "#006ec8"     # acentos
CR_ROJO = "#c62828"     # acento rojo del logo / alertas
CR_GRIS = "#4a5563"     # texto secundario
CR_FONDO = "#fbfcfd"    # fondo de pagina
CR_BORDE = "#d5dee8"

# =====================================================================================
AC_POR_HA = 2.4710538147
M2_POR_UNIDAD = 4046.8564224 if UNIDAD_AREA == "ac" else 10000.0
U = UNIDAD_AREA


def a_unidad(m2):
    return m2 / M2_POR_UNIDAD


# =====================================================================================
# 1. PROYECCION UTM (sin pyproj)
# =====================================================================================
_A = 6378137.0
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_K0 = 0.9996


def utm_zone(lon):
    return int((lon + 180) // 6) + 1


def ll_to_utm(lon, lat, zone, south=False):
    lon = np.asarray(lon, float)
    lat = np.asarray(lat, float)
    phi = np.radians(lat)
    lam0 = math.radians((zone - 1) * 6 - 180 + 3)
    lam = np.radians(lon)
    e2, e4, e6 = _E2, _E2 ** 2, _E2 ** 3
    N = _A / np.sqrt(1 - e2 * np.sin(phi) ** 2)
    T = np.tan(phi) ** 2
    C = _EP2 * np.cos(phi) ** 2
    A = np.cos(phi) * (lam - lam0)
    M = _A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
              - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * np.sin(2 * phi)
              + (15 * e4 / 256 + 45 * e6 / 1024) * np.sin(4 * phi)
              - (35 * e6 / 3072) * np.sin(6 * phi))
    x = _K0 * N * (A + (1 - T + C) * A ** 3 / 6
                   + (5 - 18 * T + T ** 2 + 72 * C - 58 * _EP2) * A ** 5 / 120) + 500000.0
    y = _K0 * (M + N * np.tan(phi) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
                                      + (61 - 58 * T + T ** 2 + 600 * C - 330 * _EP2) * A ** 6 / 720))
    if south:
        y = y + 10000000.0
    return x, y


def utm_to_ll(x, y, zone, south=False):
    x = np.asarray(x, float) - 500000.0
    y = np.asarray(y, float) - (10000000.0 if south else 0.0)
    e2, e4, e6 = _E2, _E2 ** 2, _E2 ** 3
    lam0 = math.radians((zone - 1) * 6 - 180 + 3)
    M = y / _K0
    mu = M / (_A * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * np.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * np.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * np.sin(6 * mu) + (1097 * e1 ** 4 / 512) * np.sin(8 * mu))
    C1 = _EP2 * np.cos(phi1) ** 2
    T1 = np.tan(phi1) ** 2
    N1 = _A / np.sqrt(1 - e2 * np.sin(phi1) ** 2)
    R1 = _A * (1 - e2) / (1 - e2 * np.sin(phi1) ** 2) ** 1.5
    D = x / (N1 * _K0)
    phi = phi1 - (N1 * np.tan(phi1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * _EP2) * D ** 4 / 24
                                             + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * _EP2 - 3 * C1 ** 2) * D ** 6 / 720)
    lam = lam0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
                  + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * _EP2 + 24 * T1 ** 2) * D ** 5 / 120) / np.cos(phi1)
    return np.degrees(lam), np.degrees(phi)


def prj_utm(zone, south=False):
    cm = (zone - 1) * 6 - 180 + 3
    hemi = "S" if south else "N"
    fn = 10000000.0 if south else 0.0
    return ('PROJCS["WGS_1984_UTM_Zone_%d%s",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
            'SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],'
            'UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],'
            'PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",%.1f],'
            'PARAMETER["Central_Meridian",%.1f],PARAMETER["Scale_Factor",0.9996],'
            'PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]' % (zone, hemi, fn, cm))


# =====================================================================================
# 2. LECTURA DE ENTRADAS
# =====================================================================================
def buscar_entradas(base):
    """Devuelve lista de (nombre, bytes) para KML y lista de (nombre, dict de bytes) para SHP."""
    kmls, shps = [], []

    def agregar_shp(nombre, getter, lista_nombres):
        for n in lista_nombres:
            if n.lower().endswith(".shp"):
                stem = n[:-4]
                partes = {}
                for ext in (".shp", ".dbf", ".prj", ".cpg"):
                    for cand in (stem + ext, stem + ext.upper()):
                        if cand in lista_nombres:
                            partes[ext] = getter(cand)
                            break
                shps.append((nombre + ":" + os.path.basename(n), partes))

    for raiz, dirs, archivos in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith("Calidad_Aplicacion_")]
        for a in sorted(archivos):
            ruta = os.path.join(raiz, a)
            al = a.lower()
            if al.endswith(".kml"):
                with open(ruta, "rb") as fh:
                    kmls.append((a, fh.read()))
            elif al.endswith(".kmz") or al.endswith(".zip"):
                try:
                    z = zipfile.ZipFile(ruta)
                except zipfile.BadZipFile:
                    continue
                nombres = z.namelist()
                for n in sorted(nombres):
                    if n.lower().endswith(".kml"):
                        kmls.append((os.path.basename(n), z.read(n)))
                agregar_shp(a, z.read, nombres)
            elif al.endswith(".shp"):
                stem = ruta[:-4]
                partes = {}
                for ext in (".shp", ".dbf", ".prj", ".cpg"):
                    for cand in (stem + ext, stem + ext.upper()):
                        if os.path.exists(cand):
                            with open(cand, "rb") as fh:
                                partes[ext] = fh.read()
                            break
                shps.append((a, partes))
    return kmls, shps


def _num(s, default=0.0):
    try:
        return float(str(s).strip())
    except (TypeError, ValueError):
        return default


def leer_kml(nombre, data):
    """Devuelve (vuelos, poligonos_lote_lonlat)."""
    txt = data.decode("utf-8", errors="replace")
    vuelos, polis = [], []
    m_fecha = re.search(r"_(\d{14})_", nombre)
    fecha = dt.datetime.strptime(m_fecha.group(1), "%Y%m%d%H%M%S") if m_fecha else None
    for pm in re.findall(r"<Placemark\b.*?</Placemark>", txt, re.S):
        datos = {k.strip(): v.strip() for k, v in
                 re.findall(r'<Data name="([^"]+)">\s*<value>([^<]*)</value>', pm)}
        nm = re.search(r"<name>([^<]*)</name>", pm)
        if "<Polygon" in pm:
            for anillo in re.findall(r"<coordinates>(.*?)</coordinates>", pm, re.S):
                pts = [[float(v) for v in p.split(",")[:2]] for p in anillo.split()]
                polis.append([np.array(pts)])
            continue
        coords = re.findall(r"<LineString>.*?<coordinates>(.*?)</coordinates>", pm, re.S)
        if not coords:
            continue
        pts = np.array([[float(v) for v in p.split(",")[:2]] for p in coords[0].split()])
        if len(pts) < 2:
            continue
        vuelos.append(dict(
            archivo=nombre, id=nm.group(1) if nm else nombre, fecha=fecha, lonlat=pts,
            equipo=datos.get("Aircraft Name", ""), piloto=datos.get("Pilot Name", ""),
            modo=datos.get("Mode Selection", ""),
            tiempo_s=_num(datos.get("Flight Time")) / 1000.0,
            altura=_num(datos.get("Height"), np.nan),
            ancho=_num(datos.get("Route Spacing"), np.nan),
            velocidad=_num(datos.get("Task Flight Speed"), np.nan),
            area_dji_ha=_num(datos.get("Task Area")),
            litros=_num(datos.get("Spray amount")) / 1000.0,
        ))
    return vuelos, polis


def leer_dbf(b, cod="utf-8"):
    if not b:
        return []
    n, hl, rl = struct.unpack("<IHH", b[4:12])
    campos = []
    for i in range((hl - 33) // 32):
        d = b[32 + 32 * i: 64 + 32 * i]
        if d[0] == 0x0D:
            break
        campos.append((d[:11].split(b"\0")[0].decode("latin1"), chr(d[11]), d[16]))
    regs = []
    for r in range(n):
        rec = b[hl + r * rl + 1: hl + (r + 1) * rl]
        p, out = 0, {}
        for nm, t, l in campos:
            v = rec[p:p + l]
            try:
                v = v.decode(cod).strip()
            except UnicodeDecodeError:
                v = v.decode("latin1").strip()
            out[nm] = v
            p += l
        regs.append(out)
    return regs


def leer_shp(partes):
    """Devuelve lista de (anillos, atributos) y el texto del .prj."""
    b = partes.get(".shp")
    if not b:
        return [], ""
    prj = partes.get(".prj", b"").decode("latin1", errors="replace")
    cod = partes.get(".cpg", b"utf-8").decode("latin1").strip() or "utf-8"
    attrs = leer_dbf(partes.get(".dbf"), "utf-8" if "utf" in cod.lower() else "latin1")
    out, pos, i = [], 100, 0
    while pos + 8 <= len(b):
        _, largo = struct.unpack(">2i", b[pos:pos + 8])
        rec = b[pos + 8: pos + 8 + 2 * largo]
        pos += 8 + 2 * largo
        st = struct.unpack("<i", rec[:4])[0]
        if st in (5, 15, 25) and len(rec) > 44:
            npart, npt = struct.unpack("<2i", rec[36:44])
            partes_i = list(struct.unpack("<%di" % npart, rec[44:44 + 4 * npart])) + [npt]
            pts = np.frombuffer(rec[44 + 4 * npart: 44 + 4 * npart + 16 * npt], "<f8").reshape(-1, 2)
            anillos = [pts[partes_i[k]:partes_i[k + 1]].copy() for k in range(npart)]
            out.append((anillos, attrs[i] if i < len(attrs) else {}))
        i += 1
    return out, prj


# =====================================================================================
# 3. GEOMETRIA / RASTER
# =====================================================================================
def caja(arr, r):
    """Suma movil en ventana cuadrada (2r+1) usando imagen integral."""
    a = np.pad(arr.astype(np.int32), r, mode="constant")
    ii = np.zeros((a.shape[0] + 1, a.shape[1] + 1), np.int64)
    ii[1:, 1:] = a.cumsum(0).cumsum(1)
    k = 2 * r + 1
    n, m = arr.shape
    return ii[k:k + n, k:k + m] - ii[0:n, k:k + m] - ii[k:k + n, 0:m] + ii[0:n, 0:m]


def dilatar(m, r):
    return caja(m, r) > 0


def erosionar(m, r):
    return caja(m, r) == (2 * r + 1) ** 2


def apertura(m, r):
    return dilatar(erosionar(m, r), r)


def cierre(m, r):
    d = dilatar(m, r)
    return ~dilatar(~d, r)


def suavizar(arr, sigma_celdas):
    if sigma_celdas <= 0:
        return arr
    r = int(math.ceil(3 * sigma_celdas))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_celdas) ** 2)
    k /= k.sum()
    out = arr.astype(float)
    for eje in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[eje] = (r, r)
        a = np.pad(out, pad, mode="constant")
        acc = np.zeros_like(out)
        n = out.shape[eje]
        for j, w in enumerate(k):
            sl = [slice(None), slice(None)]
            sl[eje] = slice(j, j + n)
            acc += w * a[tuple(sl)]
        out = acc
    return out


class Malla:
    def __init__(self, xmin, ymin, xmax, ymax, res):
        self.res = res
        self.xmin = math.floor(xmin / res) * res
        self.ymax = math.ceil(ymax / res) * res
        self.nc = int(math.ceil((xmax - self.xmin) / res))
        self.nf = int(math.ceil((self.ymax - ymin) / res))
        self.ymin = self.ymax - self.nf * res
        self.xmax = self.xmin + self.nc * res
        self.cx = self.xmin + (np.arange(self.nc) + 0.5) * res
        self.cy = self.ymax - (np.arange(self.nf) + 0.5) * res

    def ventana(self, x0, y0, x1, y1):
        c0 = max(0, int((x0 - self.xmin) / self.res))
        c1 = min(self.nc, int((x1 - self.xmin) / self.res) + 1)
        f0 = max(0, int((self.ymax - y1) / self.res))
        f1 = min(self.nf, int((self.ymax - y0) / self.res) + 1)
        return f0, f1, c0, c1

    def extent(self):
        return (self.xmin, self.xmax, self.ymin, self.ymax)


def rasterizar_poligono(malla, anillos):
    """Par-impar sobre todos los anillos (respeta huecos)."""
    m = np.zeros((malla.nf, malla.nc), bool)
    for an in anillos:
        if len(an) < 3:
            continue
        f0, f1, c0, c1 = malla.ventana(an[:, 0].min(), an[:, 1].min(), an[:, 0].max(), an[:, 1].max())
        if f1 <= f0 or c1 <= c0:
            continue
        X, Y = np.meshgrid(malla.cx[c0:c1], malla.cy[f0:f1])
        dentro = MplPath(an).contains_points(np.column_stack([X.ravel(), Y.ravel()]))
        m[f0:f1, c0:c1] ^= dentro.reshape(X.shape)
    return m


def faja_segmento(malla, x0, y0, x1, y1, hw):
    """Mascara (en ventana) de la faja rectangular de un segmento, extremos planos."""
    L = math.hypot(x1 - x0, y1 - y0)
    if L < 1e-6:
        return None
    ux, uy = (x1 - x0) / L, (y1 - y0) / L
    f0, f1, c0, c1 = malla.ventana(min(x0, x1) - hw, min(y0, y1) - hw, max(x0, x1) + hw, max(y0, y1) + hw)
    if f1 <= f0 or c1 <= c0:
        return None
    dx = malla.cx[c0:c1][None, :] - x0
    dy = malla.cy[f0:f1][:, None] - y0
    t = dx * ux + dy * uy
    d = np.abs(-dx * uy + dy * ux)
    m = (t >= 0) & (t < L) & (d <= hw)
    return (f0, f1, c0, c1), m


# =====================================================================================
# 4. SEPARAR PASADAS DE TRASLADOS
# =====================================================================================
def rumbos(xy):
    d = np.diff(xy, axis=0)
    L = np.hypot(d[:, 0], d[:, 1])
    ang = np.degrees(np.arctan2(d[:, 1], d[:, 0])) % 180.0
    return L, ang


def dif_ang(a, b):
    d = np.abs((a - b) % 180.0)
    return np.minimum(d, 180.0 - d)


def rumbos_candidatos(vuelos):
    hist = np.zeros(180)
    for v in vuelos:
        L, ang = rumbos(v["xy"])
        np.add.at(hist, np.round(ang).astype(int) % 180, L)
    hs = sum(np.roll(hist, k) for k in (-2, -1, 0, 1, 2))
    cands = []
    for i in np.argsort(hs)[::-1]:
        if hs[i] < 0.15 * hs.max():
            break
        if all(dif_ang(i, c) > 10 for c in cands):
            cands.append(float(i))
    # refinar cada candidato con el promedio ponderado de los segmentos cercanos
    ref = []
    for c in cands:
        num = den = 0.0
        for v in vuelos:
            L, ang = rumbos(v["xy"])
            sel = dif_ang(ang, c) <= 3
            d = ((ang[sel] - c + 90) % 180) - 90
            num += (d * L[sel]).sum()
            den += L[sel].sum()
        ref.append((c + num / den) % 180 if den else c)
    return ref


def clasificar_segmentos(v, cands, tol):
    L, ang = rumbos(v["xy"])
    w = v["ancho_m"]
    mejor, err_min = None, None
    for c in cands:
        da = dif_ang(ang, c)
        sel = da <= tol
        area = L[sel].sum() * w / 10000.0
        if v["area_dji_ha"] > 0:
            err = abs(area - v["area_dji_ha"]) / v["area_dji_ha"]
        else:
            err = -area
        if err_min is None or err < err_min:
            mejor, err_min = c, err
    v["rumbo"] = mejor
    if mejor is None:
        v["es_pasada"] = np.zeros(len(L), bool)
    else:
        da = dif_ang(ang, mejor)
        v["es_pasada"] = da <= tol
    v["long_pasadas_m"] = float(L[v["es_pasada"]].sum())
    v["long_total_m"] = float(L.sum())


# =====================================================================================
# 5. PROCESO PRINCIPAL
# =====================================================================================
def main():
    base = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
    kml_files, shp_files = buscar_entradas(base)
    if not kml_files:
        here = os.path.dirname(os.path.abspath(__file__))
        if here != base:
            base = here
            kml_files, shp_files = buscar_entradas(base)
    print("Carpeta:", base)
    print("KML encontrados:", len(kml_files), " | Shapefiles:", len(shp_files))
    if not kml_files:
        print("ERROR: no se encontraron KML del drone en la carpeta.")
        return

    vuelos, polis_kml = [], []
    vistos = set()
    for nombre, data in kml_files:
        vs, ps = leer_kml(nombre, data)
        for v in vs:
            clave = (v["id"], round(v["litros"], 3), len(v["lonlat"]))
            if clave in vistos:
                continue
            vistos.add(clave)
            vuelos.append(v)
        polis_kml += ps
    vuelos = [v for v in vuelos if v["litros"] > 0]
    vuelos.sort(key=lambda v: (v["fecha"] or dt.datetime.min, v["archivo"]))
    if not vuelos:
        print("ERROR: los KML no tienen vuelos con litros asperjados.")
        return
    print("Vuelos con aplicacion:", len(vuelos))

    # --- shapefiles: tablones y (opcional) prescripcion de tasa variada ---
    def es_prescripcion(feats):
        if not feats:
            return None
        nombres = list(feats[0][1].keys())
        cands = [CAMPO_DOSIS_PRESCRIPCION] if CAMPO_DOSIS_PRESCRIPCION else \
            [n for n in nombres if any(t in n.upper() for t in ("DOSIS", "DOSE", "RATE", "TASA"))]
        for c in cands:
            if c in nombres:
                try:
                    vals_ = [float(at[c]) for _, at in feats if str(at.get(c, "")).strip()]
                except ValueError:
                    continue
                if vals_ and max(vals_) > 0:
                    return c
        return None

    lote, presc_feats, prj_lote, prj_presc, campo_presc = [], [], "", "", None
    for nombre, partes in shp_files:
        feats, prj = leer_shp(partes)
        if not feats:
            continue
        cp = es_prescripcion(feats)
        if cp:
            presc_feats += feats
            prj_presc = prj_presc or prj
            campo_presc = cp
            print("  prescripción (tasa variada):", nombre, "-", len(feats), "zonas, campo", cp)
        else:
            lote += feats
            prj_lote = prj_lote or prj
            print("  tablones:", nombre, "-", len(feats), "polígonos")
    if not lote and polis_kml:
        lote = [(p, {}) for p in polis_kml]
        print("  lote tomado de polígonos dentro de los KML")
    if not lote:
        print("AVISO: sin shapefile de tablones. Solo se evaluarán traslapes de las pasadas.")
    TASA_VARIADA = bool(presc_feats)
    f_presc = (1 / 10000.0) if UNIDAD_PRESCRIPCION.lower().replace(" ", "") in ("l/ha", "lha") else (1 / 4046.8564224)

    # --- proyeccion ---
    todos = np.vstack([v["lonlat"] for v in vuelos])
    zona = utm_zone(float(np.median(todos[:, 0])))
    sur = float(np.median(todos[:, 1])) < 0

    def info_prj(prj_txt):
        m_utm = re.search(r"UTM_Zone_(\d+)([NS])", prj_txt or "", re.I)
        if m_utm and "PROJCS" in (prj_txt or ""):
            return int(m_utm.group(1)), m_utm.group(2).upper() == "S"
        return None

    if info_prj(prj_lote):
        zona, sur = info_prj(prj_lote)
    for v in vuelos:
        x, y = ll_to_utm(v["lonlat"][:, 0], v["lonlat"][:, 1], zona, sur)
        v["xy"] = np.column_stack([x, y])
        v["ancho_m"] = ANCHO_FAJA_M if ANCHO_FAJA_M else (v["ancho"] if v["ancho"] == v["ancho"] and v["ancho"] > 0 else 7.0)

    def proyectar(feats, prj_txt):
        ip = info_prj(prj_txt)
        out = []
        for anillos, at in feats:
            nuevos = []
            for an in anillos:
                if ip:
                    if ip == (zona, sur):
                        nuevos.append(an)
                    else:
                        lo_, la_ = utm_to_ll(an[:, 0], an[:, 1], ip[0], ip[1])
                        x, y = ll_to_utm(lo_, la_, zona, sur)
                        nuevos.append(np.column_stack([x, y]))
                else:
                    x, y = ll_to_utm(an[:, 0], an[:, 1], zona, sur)
                    nuevos.append(np.column_stack([x, y]))
            out.append((nuevos, at))
        return out

    lote_xy = proyectar(lote, prj_lote)
    presc_xy = proyectar(presc_feats, prj_presc)

    # --- pasadas vs traslados ---
    cands = rumbos_candidatos(vuelos)
    for k, v in enumerate(vuelos, 1):
        clasificar_segmentos(v, cands, TOLERANCIA_ANGULO)
        v["n"] = k
        xy = v["xy"]
        idx = np.where(v["es_pasada"])[0]
        v["_idx"] = idx
        v["_largo"] = float(np.hypot(xy[idx + 1, 0] - xy[idx, 0], xy[idx + 1, 1] - xy[idx, 1]).sum())

    cel_m2 = RESOLUCION_M ** 2
    cel_u = cel_m2 / M2_POR_UNIDAD
    tol = TOLERANCIA_DOSIS / 100.0
    A_dji = sum(v["area_dji_ha"] for v in vuelos) * 10000
    L_tot = sum(v["litros"] for v in vuelos)
    t_total = sum(v["tiempo_s"] for v in vuelos)

    # --- agrupar poligonos por tablon ---
    def campo(at, nombres):
        for nm in nombres:
            for k_ in at:
                if k_.upper() == nm.upper() and str(at[k_]).strip():
                    return str(at[k_]).strip()
        return ""

    def txt_num(s):
        try:
            f = float(s)
            return str(int(f)) if f == int(f) else s
        except ValueError:
            return s

    campos_tab = [CAMPO_TABLON] if CAMPO_TABLON else ["TAB", "TABLON", "TABLÓN", "ID_TABLON", "TABLON_ID", "LOTE"]
    grupos = {}
    for i, (anillos, at) in enumerate(lote_xy):
        tab = txt_num(campo(at, campos_tab)) or ("Lote %d" % (i + 1))
        div = txt_num(campo(at, ["DIVISION_C", "DIVISION", "DIV"]))
        grupos.setdefault((div, tab), []).append((anillos, at))
    nombres_tab = {}
    cuenta = {}
    for div, tab in grupos:
        cuenta[tab] = cuenta.get(tab, 0) + 1
    for div, tab in grupos:
        nombres_tab[(div, tab)] = tab if cuenta[tab] == 1 or not div else "%s (Div. %s)" % (tab, div)
    if not grupos:
        grupos[("", "Área aplicada")] = []
        nombres_tab[("", "Área aplicada")] = "Área aplicada"
    print("Tablones en el shapefile:", len(grupos))
    if TASA_VARIADA:
        print("MODO TASA VARIADA: la dosis se compara contra la prescripción (%s)" % UNIDAD_PRESCRIPCION)

    # --- geometria fija de cada tablon tocado (independiente del ancho de faja) ---
    marg = max(v["ancho_m"] for v in vuelos) + 10 + MARGEN_FAJA_M
    r_calle = max(1, int(round(DIST_CALLES_M / RESOLUCION_M)))
    todos_segs = np.array([(v["xy"][j, 0], v["xy"][j, 1], v["xy"][j + 1, 0], v["xy"][j + 1, 1])
                           for v in vuelos for j in v["_idx"]]) if any(len(v["_idx"]) for v in vuelos) else np.zeros((0, 4))
    if not len(todos_segs):
        print("ERROR: no se detectaron pasadas de aplicación en los KML.")
        return
    hw_max = max(v["ancho_m"] for v in vuelos) / 2 + MARGEN_FAJA_M
    gx0 = np.minimum(todos_segs[:, 0], todos_segs[:, 2]) - hw_max
    gx1 = np.maximum(todos_segs[:, 0], todos_segs[:, 2]) + hw_max
    gy0 = np.minimum(todos_segs[:, 1], todos_segs[:, 3]) - hw_max
    gy1 = np.maximum(todos_segs[:, 1], todos_segs[:, 3]) + hw_max
    geo = []
    for clave, feats in sorted(grupos.items(), key=lambda kv: (kv[0][0], kv[0][1].zfill(12))):
        if feats:
            todos_pts = np.vstack([an for anillos, _ in feats for an in anillos])
            bx0, by0 = todos_pts.min(0)
            bx1, by1 = todos_pts.max(0)
        else:
            bx0, by0, bx1, by1 = gx0.min(), gy0.min(), gx1.max(), gy1.max()
        if not ((gx1 >= bx0) & (gx0 <= bx1) & (gy1 >= by0) & (gy0 <= by1)).any():
            continue
        malla = Malla(bx0 - marg, by0 - marg, bx1 + marg, by1 + marg, RESOLUCION_M)
        etiqueta = np.zeros((malla.nf, malla.nc), np.int16)
        for i, (anillos, _) in enumerate(feats, 1):
            etiqueta[rasterizar_poligono(malla, anillos)] = i
        presc = None
        if TASA_VARIADA:
            presc = np.full((malla.nf, malla.nc), np.nan, np.float32)
            for anillos, at in presc_xy:
                pts_z = np.vstack(anillos)
                if pts_z[:, 0].max() < malla.xmin or pts_z[:, 0].min() > malla.xmax or \
                        pts_z[:, 1].max() < malla.ymin or pts_z[:, 1].min() > malla.ymax:
                    continue
                presc[rasterizar_poligono(malla, anillos)] = float(at[campo_presc]) * f_presc   # L/m2
        geo.append(dict(clave=clave, nombre=nombres_tab[clave], feats=feats, malla=malla, etiqueta=etiqueta,
                        presc=presc, bbox=(bx0, by0, bx1, by1)))

    # --- motor: corre el analisis completo para un ancho de faja dado (dw = variacion en m) ---
    def correr(dw, completo):
        segs = []
        for v in vuelos:
            w = v["ancho_m"] + dw
            for j in v["_idx"]:
                segs.append((v["xy"][j, 0], v["xy"][j, 1], v["xy"][j + 1, 0], v["xy"][j + 1, 1], w / 2.0, v["n"] - 1))
        segs = np.array(segs)
        sx0 = np.minimum(segs[:, 0], segs[:, 2]) - segs[:, 4]
        sx1 = np.maximum(segs[:, 0], segs[:, 2]) + segs[:, 4]
        sy0 = np.minimum(segs[:, 1], segs[:, 3]) - segs[:, 4]
        sy1 = np.maximum(segs[:, 1], segs[:, 3]) + segs[:, 4]
        area_v = np.array([v["_largo"] * (v["ancho_m"] + dw) for v in vuelos])
        litros_v = np.array([v["litros"] for v in vuelos])
        dosis_v = np.where(area_v > 0, litros_v / np.maximum(area_v, 1e-9), np.nan)   # L/m2 promedio del vuelo
        A_barr = float(area_v.sum())

        # 1) fajas por tablon (se guardan para no rasterizar dos veces)
        pre = []
        sp = np.zeros(len(vuelos)); npc = np.zeros(len(vuelos))
        for G in geo:
            bx0, by0, bx1, by1 = G["bbox"]
            sel = np.where((sx1 >= bx0 - marg) & (sx0 <= bx1 + marg) & (sy1 >= by0 - marg) & (sy0 <= by1 + marg))[0]
            mascaras = []
            for s in sel:
                x0, y0, x1, y1, hw, iv = segs[s]
                r = faja_segmento(G["malla"], x0, y0, x1, y1, hw)
                if r is not None:
                    mascaras.append((int(iv), r))
            en_lote = G["etiqueta"] > 0
            envolvente = cierre(en_lote, r_calle) if en_lote.any() else en_lote
            zona_t = envolvente
            if TASA_VARIADA:
                for iv, ((f0, f1, c0, c1), m) in mascaras:
                    pz = G["presc"][f0:f1, c0:c1]
                    ok = m & zona_t[f0:f1, c0:c1] & ~np.isnan(pz)
                    sp[iv] += float(pz[ok].sum()) * cel_m2
                    npc[iv] += int(ok.sum())
            pre.append((G, mascaras, en_lote, envolvente))

        # 2) factor de calibracion por vuelo (tasa variada)
        if TASA_VARIADA:
            todas = np.concatenate([G["presc"][~np.isnan(G["presc"])] for G in geo]) if geo else np.array([])
            media_presc = float(todas.mean()) if todas.size else np.nan
            def_v = np.where(npc > 0, sp / np.maximum(npc * cel_m2, 1e-9), media_presc)
            esperado_v = sp + np.maximum(area_v - npc * cel_m2, 0) * def_v
            factor_v = np.where(esperado_v > 0, litros_v / np.maximum(esperado_v, 1e-9), np.nan)
        else:
            def_v = dosis_v
            esperado_v = None
            factor_v = np.ones(len(vuelos))
        ref_glob = (DOSIS_OBJETIVO / M2_POR_UNIDAD) if DOSIS_OBJETIVO else (
            float(np.nanmean(todas)) if TASA_VARIADA and todas.size else L_tot / A_barr)

        # 3) dosis y estadisticas por tablon
        res = []
        L_dentro_v = np.zeros(len(vuelos))
        tabs_v = [[] for _ in vuelos]
        hist = np.zeros(nbins_h + 2)
        cntp = {}
        for G, mascaras, en_lote, envolvente in pre:
            malla = G["malla"]
            pasadas = np.zeros((malla.nf, malla.nc), np.int16)
            dosis = np.zeros((malla.nf, malla.nc), np.float32)
            for iv, ((f0, f1, c0, c1), m) in mascaras:
                pasadas[f0:f1, c0:c1] += m
                if TASA_VARIADA:
                    pz = G["presc"][f0:f1, c0:c1]
                    dz = np.where(np.isnan(pz), def_v[iv], pz) * factor_v[iv]
                    dosis[f0:f1, c0:c1] += m * dz.astype(np.float32)
                else:
                    dosis[f0:f1, c0:c1] += m * np.float32(dosis_v[iv])
            etiqueta = G["etiqueta"]
            if not G["feats"]:
                en_lote = cierre(pasadas > 0, max(1, int(round(max(v["ancho_m"] for v in vuelos) / RESOLUCION_M))))
                etiqueta = en_lote.astype(np.int16)
                envolvente = cierre(en_lote, r_calle)
            if not en_lote.any():
                continue
            cub = en_lote & (pasadas > 0)
            cobert = cub.sum() / en_lote.sum() * 100
            if cobert < UMBRAL_TABLON_PCT:
                continue
            calles = envolvente & ~en_lote
            if SUAVIZADO_M > 0:
                dosis = suavizar(dosis, SUAVIZADO_M / RESOLUCION_M).astype(np.float32)
            clases = np.zeros((malla.nf, malla.nc), np.uint8)
            clases[en_lote & (pasadas == 1)] = 1
            clases[en_lote & (pasadas >= 2)] = 2
            clases[en_lote & (pasadas == 0)] = 3
            clases[calles & (pasadas >= 1)] = 4
            clases[~envolvente & (pasadas >= 1)] = 5
            if FRANJA_MINIMA_M > 0:
                r_f = max(1, int(round(FRANJA_MINIMA_M / RESOLUCION_M / 2)))
                for c in (2, 3):
                    m = clases == c
                    clases[m & ~apertura(m, r_f)] = 1
            # referencia por celda: prescripcion (tasa variada) o dosis de referencia global
            if TASA_VARIADA:
                refc = np.where(np.isnan(G["presc"]), ref_glob, G["presc"]).astype(np.float32)
            else:
                refc = np.full((malla.nf, malla.nc), ref_glob, np.float32)
            razon = dosis / np.maximum(refc, 1e-12)          # aplicada / referencia
            en_rango = en_lote & (np.abs(razon - 1) <= tol)
            d_unidad = dosis * M2_POR_UNIDAD
            vals = d_unidad[cub].astype(float)
            nombre = G["nombre"]
            vuelos_t = set()
            for iv, ((f0, f1, c0, c1), m) in mascaras:
                inn = m & en_lote[f0:f1, c0:c1]
                if inn.any():
                    if TASA_VARIADA:
                        pz = G["presc"][f0:f1, c0:c1]
                        L_dentro_v[iv] += float((np.where(np.isnan(pz), def_v[iv], pz) * factor_v[iv])[inn].sum()) * cel_m2
                    else:
                        L_dentro_v[iv] += int(inn.sum()) * cel_m2 * dosis_v[iv]
                    vuelos_t.add(iv + 1)
                    if nombre not in tabs_v[iv]:
                        tabs_v[iv].append(nombre)
            rl = razon[en_lote]
            pl = pasadas[en_lote]
            hist[0] += (pl == 0).sum()
            rr = rl[pl > 0]
            hist[1:-1] += np.histogram(rr, bins=nbins_h, range=(0, 3.0))[0]
            hist[-1] += (rr >= 3.0).sum()
            for kk, nn in zip(*np.unique(pl, return_counts=True)):
                cntp[int(kk)] = cntp.get(int(kk), 0) + int(nn)
            T = dict(nombre=nombre, division=G["clave"][0], n_piezas=len(G["feats"]),
                     A_lote=en_lote.sum() * cel_m2,
                     A_apl=(clases == 1).sum() * cel_m2, A_sob=(clases == 2).sum() * cel_m2,
                     A_no=(clases == 3).sum() * cel_m2, A_calle=(clases == 4).sum() * cel_m2,
                     A_mult=float(pasadas[en_lote | calles].sum() * cel_m2),
                     L_in=float(dosis[en_lote].sum() * cel_m2), L_calle=float(dosis[calles].sum() * cel_m2),
                     L_presc=float(np.nansum(np.where(en_lote, refc, 0)) * cel_m2) if TASA_VARIADA else np.nan,
                     A_cub=cub.sum() * cel_m2, n_rango=int(en_rango.sum()), n_lote=int(en_lote.sum()),
                     n_bajo=int((en_lote & (razon < 1 - tol)).sum()),
                     n_alto=int((en_lote & (razon > 1 + tol)).sum()),
                     s1=float(vals.sum()), s2=float((vals ** 2).sum()), nv=int(vals.size),
                     L_exceso=float(np.clip(dosis[en_lote] - refc[en_lote] * (1 + tol), 0, None).sum() * cel_m2),
                     vuelos=sorted(vuelos_t),
                     variedades=sorted({at.get("VARIEDAD_N", "") for _, at in G["feats"]} - {""}))
            T["cv"] = (math.sqrt(max(T["s2"] / T["nv"] - (T["s1"] / T["nv"]) ** 2, 0)) / (T["s1"] / T["nv"]) * 100
                       if T["nv"] else np.nan)
            T["dosis_cub"] = T["L_in"] / T["A_cub"] * M2_POR_UNIDAD if T["A_cub"] else np.nan
            T["unif"] = T["n_rango"] / T["n_lote"] * 100
            T["cobertura"] = (T["A_apl"] + T["A_sob"]) / T["A_lote"] * 100
            if completo:
                piezas = []
                for i, (_, at) in enumerate(G["feats"], 1):
                    m = etiqueta == i
                    a = m.sum() * cel_m2
                    if a == 0:
                        continue
                    cb = m & (pasadas > 0)
                    L_p = float(dosis[m].sum() * cel_m2)
                    vv = d_unidad[cb]
                    nom = campo(at, ["PIEZ", "PIEZA"]) or str(i)
                    try:
                        nom = str(int(float(nom))).zfill(3)
                    except ValueError:
                        pass
                    ff, cc = np.where(m)
                    piezas.append(dict(
                        pieza=nom, variedad=at.get("VARIEDAD_N", ""), area=a,
                        apl=((clases == 1) & m).sum() * cel_m2, sob=((clases == 2) & m).sum() * cel_m2,
                        no=((clases == 3) & m).sum() * cel_m2, litros=L_p,
                        dosis_cub=(L_p / (cb.sum() * cel_m2) * M2_POR_UNIDAD) if cb.any() else np.nan,
                        dosis_ef=L_p / a * M2_POR_UNIDAD,
                        cv=float(vv.std() / vv.mean() * 100) if vv.size else np.nan,
                        unif=(en_rango & m).sum() / m.sum() * 100,
                        xy=(malla.cx[int(np.median(cc))], malla.cy[int(np.median(ff))])))
                piezas.sort(key=lambda p: p["pieza"])
                T["piezas"] = piezas
                # zonas de manejo (tasa variada)
                zonas = []
                if TASA_VARIADA:
                    pr = G["presc"]
                    for val in sorted(set(np.round(pr[en_lote & ~np.isnan(pr)] * M2_POR_UNIDAD, 3).tolist())):
                        mz = en_lote & ~np.isnan(pr) & (np.abs(pr * M2_POR_UNIDAD - val) < 1e-3)
                        cbz = mz & (pasadas > 0)
                        Lz = float(dosis[mz].sum() * cel_m2)
                        zonas.append(dict(presc=val, area=mz.sum() * cel_m2, cub=cbz.sum() * cel_m2,
                                          aplicada=(Lz / (cbz.sum() * cel_m2) * M2_POR_UNIDAD) if cbz.any() else np.nan,
                                          L_apl=Lz, L_presc=float(pr[mz].sum() * cel_m2),
                                          unif=(en_rango & mz).sum() / max(mz.sum(), 1) * 100))
                T["zonas"] = zonas
                T["_raster"] = (malla, clases, np.where(pasadas > 0, d_unidad, -9999), pasadas,
                                np.where(pasadas > 0, razon * 100, -9999))
                ff = np.where((clases > 0).any(1))[0]
                cc = np.where((clases > 0).any(0))[0]
                f0, f1, c0, c1 = ff[0], ff[-1] + 1, cc[0], cc[-1] + 1
                paso = max(1, int(math.ceil(max(f1 - f0, c1 - c0) / 1100.0)))
                T["disp_clases"] = clases[f0:f1:paso, c0:c1:paso].copy()
                T["disp_razon"] = np.where(pasadas[f0:f1:paso, c0:c1:paso] > 0, razon[f0:f1:paso, c0:c1:paso],
                                           np.nan).astype(np.float32)
                T["disp_dosis"] = np.where(pasadas[f0:f1:paso, c0:c1:paso] > 0, d_unidad[f0:f1:paso, c0:c1:paso],
                                           np.nan).astype(np.float32)
                T["disp_presc"] = (np.where(en_lote, G["presc"], np.nan)[f0:f1:paso, c0:c1:paso] * M2_POR_UNIDAD
                                   ).astype(np.float32) if TASA_VARIADA else None
                T["disp_ext"] = (malla.xmin + c0 * RESOLUCION_M, malla.xmin + c1 * RESOLUCION_M,
                                 malla.ymax - f1 * RESOLUCION_M, malla.ymax - f0 * RESOLUCION_M)
                T["anillos"] = [an for anillos, _ in G["feats"] for an in anillos]
                print("  Tablón %-14s %7.2f %s  cobertura %5.1f%%  %d vuelos"
                      % (nombre, a_unidad(T["A_lote"]), U, cobert, len(vuelos_t)))
            res.append(T)

        tot = {}
        if res:
            def S(k):
                return sum(T[k] for T in res)
            A_lote_ = S("A_lote")
            A_cub_ = S("A_cub")
            nv_, s1_, s2_ = S("nv"), S("s1"), S("s2")
            tot = dict(A_lote=A_lote_, A_apl=S("A_apl"), A_sob=S("A_sob"), A_no=S("A_no"), A_calle=S("A_calle"),
                       L_in=S("L_in"), L_calle=S("L_calle"), L_exceso=S("L_exceso"), A_cub=A_cub_,
                       A_mult=S("A_mult"), n_rango=S("n_rango"), n_lote=S("n_lote"),
                       n_bajo=S("n_bajo"), n_alto=S("n_alto"),
                       L_presc=S("L_presc") if TASA_VARIADA else np.nan,
                       cv=math.sqrt(max(s2_ / nv_ - (s1_ / nv_) ** 2, 0)) / (s1_ / nv_) * 100 if nv_ else np.nan,
                       unif=S("n_rango") / S("n_lote") * 100,
                       cobertura=(S("A_apl") + S("A_sob")) / A_lote_ * 100,
                       dosis_cub=S("L_in") / A_cub_ * M2_POR_UNIDAD if A_cub_ else np.nan)
        return dict(tablones=res, tot=tot, area_v=area_v, dosis_v=dosis_v, factor_v=factor_v,
                    esperado_v=esperado_v, L_dentro_v=L_dentro_v, tabs_v=tabs_v, hist=hist, cntp=cntp,
                    A_barrida=A_barr, ref_glob=ref_glob)

    nbins_h = 600
    print("Analizando con el ancho de faja registrado...")
    R0 = correr(0.0, True)
    tablones = R0["tablones"]
    if not tablones:
        print("ERROR: ningún tablón del shapefile recibió aplicación de estos vuelos.")
        return
    print("Calculando margen de incertidumbre (faja ±%.2f m)..." % MARGEN_FAJA_M)
    Rm = correr(-MARGEN_FAJA_M, False) if MARGEN_FAJA_M > 0 else R0
    Rp = correr(+MARGEN_FAJA_M, False) if MARGEN_FAJA_M > 0 else R0

    for i, v in enumerate(vuelos):
        v["area_calc_m2"] = float(R0["area_v"][i])
        v["dosis_calc_L_m2"] = float(R0["dosis_v"][i])
        v["factor"] = float(R0["factor_v"][i])
        v["litros_esperados"] = float(R0["esperado_v"][i]) if R0["esperado_v"] is not None else np.nan
        v["L_dentro"] = float(R0["L_dentro_v"][i])
        v["tablones"] = R0["tabs_v"][i]
        v["long_pasadas_m"] = v["_largo"]
        v["long_total_m"] = float(rumbos(v["xy"])[0].sum())
    hist_dosis, cnt_pasadas = R0["hist"], R0["cntp"]
    A_barrida = R0["A_barrida"]
    ref = R0["ref_glob"] * M2_POR_UNIDAD          # L por unidad de area
    dosis_global = L_tot / A_barrida * M2_POR_UNIDAD if A_barrida else np.nan
    dosis_dji = L_tot / A_dji * M2_POR_UNIDAD if A_dji else np.nan

    # --- totales globales ---
    tt = R0["tot"]
    A_lote, A_apl, A_sob, A_no, A_calle = tt["A_lote"], tt["A_apl"], tt["A_sob"], tt["A_no"], tt["A_calle"]
    L_in, L_calle, L_exceso = tt["L_in"], tt["L_calle"], tt["L_exceso"]
    L_presc = tt["L_presc"]
    L_fuera = max(L_tot - L_in - L_calle, 0.0)
    A_fuera = max(A_barrida - tt["A_mult"], 0.0)
    A_cub = tt["A_cub"]
    cv, unif = tt["cv"], tt["unif"]
    dosis_media_cub = tt["dosis_cub"]
    dosis_efectiva_lote = L_in / A_lote * M2_POR_UNIDAD if A_lote else np.nan

    def S(k):
        return sum(T[k] for T in tablones)

    def pct(a, b):
        return a / b * 100 if b else 0.0

    # --- margen de incertidumbre (±) ---
    def mx_dev(clave, v0, dic_m, dic_p):
        a, b = dic_m.get(clave, v0), dic_p.get(clave, v0)
        return max(abs(v0 - a), abs(b - v0))

    dji_ok = [(v["area_calc_m2"], v["area_dji_ha"] * 1e4) for v in vuelos if v["area_dji_ha"] > 0]
    err_area = (sum(abs(a - b) for a, b in dji_ok) / sum(b for a, b in dji_ok)) if dji_ok else 0.0
    if TASA_VARIADA:
        fv = np.array([v["factor"] for v in vuelos]); wv = np.array([v["litros"] for v in vuelos])
        ok_ = np.isfinite(fv)
        err_flujo = float(np.sqrt(np.average((fv[ok_] - np.average(fv[ok_], weights=wv[ok_])) ** 2, weights=wv[ok_]))) if ok_.any() else 0.0
    else:
        err_flujo = 0.0
    pm_m, pm_p = Rm["tot"], Rp["tot"]
    MARGEN = {}
    for k_ in ("cobertura", "unif", "cv"):
        MARGEN[k_] = mx_dev(k_, tt[k_], pm_m, pm_p)
    MARGEN["no"] = mx_dev("A_no", A_no, pm_m, pm_p) / A_lote * 100
    MARGEN["sob"] = mx_dev("A_sob", A_sob, pm_m, pm_p) / A_lote * 100
    d_w = mx_dev("dosis_cub", dosis_media_cub, pm_m, pm_p)
    MARGEN["dosis"] = math.sqrt(d_w ** 2 + (dosis_media_cub * err_area) ** 2 + (dosis_media_cub * err_flujo) ** 2)
    MARGEN["err_area"] = err_area * 100
    def rango(clave, v0, escala=1.0):
        vs = [v0, pm_m.get(clave, v0), pm_p.get(clave, v0)]
        return min(vs) * escala, max(vs) * escala
    RANGO = {"no": rango("A_no", A_no, 100.0 / A_lote), "sob": rango("A_sob", A_sob, 100.0 / A_lote),
             "cobertura": rango("cobertura", tt["cobertura"]), "unif": rango("unif", tt["unif"])}
    MARGEN["err_flujo"] = err_flujo * 100
    tabs_m = {T["nombre"]: T for T in Rm["tablones"]}
    tabs_p = {T["nombre"]: T for T in Rp["tablones"]}
    for T in tablones:
        a, b = tabs_m.get(T["nombre"], T), tabs_p.get(T["nombre"], T)
        T["m_cob"] = max(abs(T["cobertura"] - a["cobertura"]), abs(b["cobertura"] - T["cobertura"]))
        T["m_unif"] = max(abs(T["unif"] - a["unif"]), abs(b["unif"] - T["unif"]))
        T["m_no"] = max(abs(T["A_no"] - a["A_no"]), abs(b["A_no"] - T["A_no"])) / T["A_lote"] * 100
        T["m_sob"] = max(abs(T["A_sob"] - a["A_sob"]), abs(b["A_sob"] - T["A_sob"])) / T["A_lote"] * 100
        T["r_sob"] = (min(T["A_sob"], a["A_sob"], b["A_sob"]) / T["A_lote"] * 100,
                      max(T["A_sob"], a["A_sob"], b["A_sob"]) / T["A_lote"] * 100)
        T["r_no"] = (min(T["A_no"], a["A_no"], b["A_no"]) / T["A_lote"] * 100,
                     max(T["A_no"], a["A_no"], b["A_no"]) / T["A_lote"] * 100)
        dw_t = max(abs(T["dosis_cub"] - a["dosis_cub"]), abs(b["dosis_cub"] - T["dosis_cub"]))
        T["m_dosis"] = math.sqrt(dw_t ** 2 + (T["dosis_cub"] * err_area) ** 2 + (T["dosis_cub"] * err_flujo) ** 2)

    # --- metadatos ---
    fechas = [v["fecha"] for v in vuelos if v["fecha"]]
    f_ini = min(fechas) if fechas else None
    f_fin = max(fechas) if fechas else None
    equipos = sorted({v["equipo"] for v in vuelos if v["equipo"]})
    pilotos = sorted({v["piloto"] for v in vuelos if v["piloto"]})
    if f_ini:
        sufijo = f_ini.strftime("%Y%m%d") + ("" if f_fin.date() == f_ini.date() else "-" + f_fin.strftime("%Y%m%d"))
    else:
        sufijo = dt.date.today().strftime("%Y%m%d")
    salida = os.path.join(base, "Calidad_Aplicacion_%s" % sufijo)
    capas = os.path.join(salida, "capas_SIG")
    os.makedirs(capas, exist_ok=True)

    # =================================================================================
    # 6. SALIDAS
    # =================================================================================
    def seguro(s):
        return re.sub(r"[^A-Za-z0-9_-]+", "_", s)

    def escribir_asc(ruta, malla, arr, fmt, nodata):
        with open(ruta, "w") as fh:
            fh.write("ncols %d\nnrows %d\nxllcorner %.3f\nyllcorner %.3f\ncellsize %.3f\nNODATA_value %s\n"
                     % (malla.nc, malla.nf, malla.xmin, malla.ymin, malla.res, nodata))
            np.savetxt(fh, arr, fmt=fmt)
        with open(ruta[:-4] + ".prj", "w") as fh:
            fh.write(prj_utm(zona, sur))

    for T in tablones:
        malla, clases, d_out, pas, raz = T.pop("_raster")
        pre = os.path.join(capas, "T%s_" % seguro(T["nombre"]))
        escribir_asc(pre + "clases.asc", malla, clases.astype(int), "%d", 0)
        escribir_asc(pre + "dosis_L_%s.asc" % U, malla, d_out, "%.2f", -9999)
        escribir_asc(pre + "pasadas.asc", malla, pas.astype(int), "%d", -9999)
        escribir_asc(pre + ("dosis_pct_prescripcion.asc" if TASA_VARIADA else "dosis_pct_referencia.asc"),
                     malla, raz, "%.1f", -9999)

    with open(os.path.join(salida, "resumen_vuelos.csv"), "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["vuelo", "id", "archivo", "inicio", "duracion_min", "equipo", "piloto", "tablones", "altura_m",
                    "velocidad_m_s", "ancho_faja_m", "area_equipo_%s" % U, "area_calculada_%s" % U,
                    "litros", "dosis_equipo_L_%s" % U, "dosis_calc_L_%s" % U, "dosis_calc_L_ha",
                    "litros_dentro_tablones", "long_pasadas_m", "long_traslados_m", "litros_esperados_prescripcion",
                    "factor_calibracion"])
        for v in vuelos:
            w.writerow([v["n"], v["id"], v["archivo"], v["fecha"].strftime("%Y-%m-%d %H:%M:%S") if v["fecha"] else "",
                        round(v["tiempo_s"] / 60, 2), v["equipo"], v["piloto"], " ".join(v["tablones"]),
                        v["altura"], round(v["velocidad"], 2),
                        v["ancho_m"], round(a_unidad(v["area_dji_ha"] * 1e4), 3), round(a_unidad(v["area_calc_m2"]), 3),
                        round(v["litros"], 3),
                        round(v["litros"] / a_unidad(v["area_dji_ha"] * 1e4), 2) if v["area_dji_ha"] else "",
                        round(v["dosis_calc_L_m2"] * M2_POR_UNIDAD, 2), round(v["dosis_calc_L_m2"] * 1e4, 2),
                        round(v["L_dentro"], 2), round(v["long_pasadas_m"], 1),
                        round(v["long_total_m"] - v["long_pasadas_m"], 1),
                        round(v["litros_esperados"], 2) if TASA_VARIADA else "",
                        round(v["factor"], 3) if TASA_VARIADA else ""])

    with open(os.path.join(salida, "resumen_tablones.csv"), "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["tablon", "division", "piezas", "area_%s" % U, "cobertura_pct", "no_aplicado_%s" % U,
                    "pct_no_aplicado", "sobreaplicado_%s" % U, "pct_sobreaplicado", "calles_%s" % U, "litros",
                    "dosis_area_cubierta_L_%s" % U, "cv_dosis_pct", "uniformidad_pct", "vuelos",
                    "margen_cobertura_pct", "margen_no_aplicado_pct", "margen_sobreaplicado_pct",
                    "margen_dosis_L_%s" % U, "margen_uniformidad_pct", "litros_prescritos"])
        for T in tablones:
            w.writerow([T["nombre"], T["division"], T["n_piezas"], round(a_unidad(T["A_lote"]), 3),
                        round(pct(T["A_apl"] + T["A_sob"], T["A_lote"]), 2), round(a_unidad(T["A_no"]), 3),
                        round(pct(T["A_no"], T["A_lote"]), 2), round(a_unidad(T["A_sob"]), 3),
                        round(pct(T["A_sob"], T["A_lote"]), 2), round(a_unidad(T["A_calle"]), 3), round(T["L_in"], 2),
                        round(T["dosis_cub"], 2), round(T["cv"], 2), round(T["unif"], 2),
                        " ".join(str(x) for x in T["vuelos"]), round(T["m_cob"], 2), round(T["m_no"], 2),
                        round(T["m_sob"], 2), round(T["m_dosis"], 3), round(T["m_unif"], 2),
                        round(T["L_presc"], 2) if TASA_VARIADA else ""])

    with open(os.path.join(salida, "resumen_piezas.csv"), "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["tablon", "pieza", "variedad", "area_%s" % U, "aplicado_%s" % U, "sobreaplicado_%s" % U,
                    "no_aplicado_%s" % U, "pct_no_aplicado", "pct_sobreaplicado", "litros",
                    "dosis_area_cubierta_L_%s" % U, "dosis_efectiva_L_%s" % U, "cv_dosis_pct", "uniformidad_pct"])
        for T in tablones:
            for p in T["piezas"]:
                w.writerow([T["nombre"], p["pieza"], p["variedad"], round(a_unidad(p["area"]), 3),
                            round(a_unidad(p["apl"]), 3), round(a_unidad(p["sob"]), 3), round(a_unidad(p["no"]), 3),
                            round(pct(p["no"], p["area"]), 2), round(pct(p["sob"], p["area"]), 2),
                            round(p["litros"], 2), round(p["dosis_cub"], 2), round(p["dosis_ef"], 2),
                            round(p["cv"], 2), round(p["unif"], 2)])

    # GeoJSON (WGS84): pasadas, rutas y tablones evaluados
    def a_ll(xy):
        lo, la = utm_to_ll(xy[:, 0], xy[:, 1], zona, sur)
        return [[round(float(a), 8), round(float(b), 8)] for a, b in zip(lo, la)]

    feats_p, feats_r = [], []
    for v in vuelos:
        props = dict(vuelo=v["n"], id=v["id"], litros=round(v["litros"], 3), tablones=" ".join(v["tablones"]),
                     dosis_L_ha=round(v["dosis_calc_L_m2"] * 1e4, 2), altura=v["altura"], ancho_m=v["ancho_m"])
        xy = v["xy"]
        sg = [a_ll(xy[j:j + 2]) for j in np.where(v["es_pasada"])[0]]
        if sg:
            feats_p.append(dict(type="Feature", properties=props, geometry=dict(type="MultiLineString", coordinates=sg)))
        feats_r.append(dict(type="Feature", properties=props,
                            geometry=dict(type="LineString", coordinates=[[round(a, 8), round(b, 8)] for a, b in v["lonlat"]])))
    feats_t = []
    for T in tablones:
        props = dict(tablon=T["nombre"], cobertura=round(pct(T["A_apl"] + T["A_sob"], T["A_lote"]), 2),
                     no_aplicado_pct=round(pct(T["A_no"], T["A_lote"]), 2),
                     sobre_pct=round(pct(T["A_sob"], T["A_lote"]), 2), litros=round(T["L_in"], 2),
                     dosis_L_ac=round(T["dosis_cub"] / M2_POR_UNIDAD * 4046.8564224, 3),
                     cv=round(T["cv"], 2), uniformidad=round(T["unif"], 2))
        polys = [[a_ll(an)] for an in T["anillos"]]
        if polys:
            feats_t.append(dict(type="Feature", properties=props, geometry=dict(type="MultiPolygon", coordinates=polys)))
    for nombre_f, f in (("pasadas_aplicacion.geojson", feats_p), ("rutas_vuelo.geojson", feats_r),
                        ("tablones_evaluados.geojson", feats_t)):
        with open(os.path.join(capas, nombre_f), "w", encoding="utf-8") as fh:
            json.dump(dict(type="FeatureCollection", features=f), fh)

    # ---------------- INFORME PDF (estilo Central Romana) ----------------
    # unidades escritas completas en el informe: "acres" para area y "L/acre" para dosis
    U_TXT = "acres" if UNIDAD_AREA == "ac" else "ha"
    U_POR = "acre" if UNIDAD_AREA == "ac" else "ha"
    import matplotlib.text as _mtext
    if not getattr(_mtext.Text.set_text, "_cr_unidad", False):
        _orig_set_text = _mtext.Text.set_text

        def _set_text(self, s_):
            if isinstance(s_, str) and "§" in s_:
                s_ = s_.replace("§", U_POR)
            return _orig_set_text(self, s_)
        _set_text._cr_unidad = True
        _mtext.Text.set_text = _set_text
    plt.rcParams["font.family"] = "sans-serif"
    plt.rcParams["font.sans-serif"] = ["Arial", "Liberation Sans", "Helvetica", "DejaVu Sans"]
    COL = {1: "#2e9e44", 2: "#c62828", 3: "#f2c80f", 4: "#f08c00", 5: "#7b3fa0"}
    NOM = {1: "Aplicado", 2: "Sobreaplicado", 3: "No aplicado", 4: "Aplicado en calles", 5: "Aplicado fuera del tablón"}
    VERDE, AMBAR = "#2e9e44", "#f08c00"
    A4 = (11.69, 8.27)
    pdf_path = os.path.join(salida, "Informe_Calidad_Aplicacion.pdf")
    logo = _cargar_logo(base)
    MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
             "octubre", "noviembre", "diciembre"]
    hoy = dt.date.today()
    fecha_informe = "%d de %s de %d" % (hoy.day, MESES[hoy.month - 1], hoy.year)
    fecha_apl = (f_ini.strftime("%d/%m/%Y") + ("" if f_fin.date() == f_ini.date() else " – " + f_fin.strftime("%d/%m/%Y"))
                 if f_ini else "-")
    cobertura = pct(A_apl + A_sob, A_lote)
    L_util = L_in - L_exceso
    efic_producto = pct(L_util, L_tot)
    fin_vuelo = [v["fecha"] + dt.timedelta(seconds=v["tiempo_s"]) for v in vuelos if v["fecha"]]
    jornada_h = ((max(fin_vuelo) - f_ini).total_seconds() / 3600) if (fin_vuelo and f_ini) else t_total / 3600
    rend_jornada = a_unidad(A_apl + A_sob) / jornada_h if jornada_h else 0
    multi_dia = bool(f_ini) and f_fin.date() != f_ini.date()
    bordes = np.array([0, 0.5, 1 - tol, 1 + tol, 1.5, 2.0 - 1e-6, 1e9]) * ref
    bordes[-1] = 1e9
    BR = np.array([0, 0.5, 1 - tol, 1 + tol, 1.5, 2.0 - 1e-6, 1e9])     # clases por razon aplicada/referencia
    PAL_D = ["#f08c00", "#f2c80f", "#2e9e44", "#7fb8e8", "#006ec8", "#c62828"]
    NOM_D = ["Muy baja", "Baja", "En objetivo", "Alta", "Muy alta", "Traslape"]

    def semaforo(valor, bueno, aceptable, mayor_es_mejor=True):
        if valor != valor:
            return CR_GRIS
        if mayor_es_mejor:
            return VERDE if valor >= bueno else (AMBAR if valor >= aceptable else CR_ROJO)
        return VERDE if valor <= bueno else (AMBAR if valor <= aceptable else CR_ROJO)

    def fondo(fig):
        fig.patch.set_facecolor(CR_FONDO)

    def poner_logo(fig, x, y, w):
        if logo is None:
            return
        h = w * logo.shape[0] / logo.shape[1] * A4[0] / A4[1]
        ax = fig.add_axes([x, y, w, h])
        ax.imshow(logo, interpolation="lanczos")
        ax.axis("off")

    def bandas(fig, alto):
        ax = fig.add_axes([0, 0, 1, alto])
        ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")
        ax.add_patch(plt.Rectangle((0, 0), 1, 1, color=CR_MARINO))
        ax.add_patch(plt.Rectangle((0, 0.45), 0.333, 0.55, color=CR_AZUL))
        ax.add_patch(plt.Rectangle((0, 0.45), 0.006, 0.55, color=CR_ROJO))
        ax.add_patch(plt.Rectangle((0.732, 0.62), 0.068, 0.38, color=CR_AZUL))
        ax.add_patch(plt.Rectangle((0.958, 0), 0.042, 0.10, color=CR_AZUL))

    def encabezado(fig, titulo, subtitulo=""):
        fondo(fig)
        fig.text(0.04, 0.925, titulo, fontsize=21, weight="bold", color=CR_MARINO, va="center")
        if subtitulo:
            fig.text(0.04, 0.878, subtitulo, fontsize=10.5, color=CR_GRIS, va="center")
        poner_logo(fig, 0.845, 0.885, 0.115)

    estado = {"pag": 1}

    def cerrar_pagina(pdf, fig):
        ax = fig.add_axes([0, 0, 1, 0.034])
        ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")
        ax.add_patch(plt.Rectangle((0, 0), 1, 1, color=CR_MARINO))
        ax.add_patch(plt.Rectangle((0, 0), 0.22, 1, color=CR_AZUL))
        ax.add_patch(plt.Rectangle((0, 0), 0.005, 1, color=CR_ROJO))
        ax.text(0.015, 0.5, "Central Romana Corporation, Ltd.", color="white", fontsize=7.5, weight="bold", va="center")
        ax.text(0.235, 0.5, "Área de Agricultura de Precisión", color="#d6e4f5", fontsize=7.5, va="center")
        ax.text(0.985, 0.5, str(estado["pag"]), color="white", fontsize=8, weight="bold", va="center", ha="right")
        estado["pag"] += 1
        pdf.savefig(fig, facecolor=fig.get_facecolor())
        plt.close(fig)

    def tarjeta(fig, x, y, w, h):
        ax = fig.add_axes([x, y, w, h])
        ax.set_xlim(0, 1); ax.set_ylim(0, 1)
        ax.set_xticks([]); ax.set_yticks([])
        ax.set_facecolor("white")
        for s in ax.spines.values():
            s.set_color(CR_BORDE)
        return ax

    def kpi(fig, x, y, w, h, titulo, valor, sub="", acento=None, fs=13):
        ax = tarjeta(fig, x, y, w, h)
        ax.add_patch(plt.Rectangle((0, 0), 0.035, 1, color=acento or CR_AZUL, clip_on=False))
        ax.text(0.53, 0.76, titulo.upper(), ha="center", va="center", fontsize=6.8, color=CR_AZUL, weight="bold")
        ax.text(0.53, 0.43, valor, ha="center", va="center", fontsize=fs, weight="bold", color=CR_MARINO)
        if sub:
            ax.text(0.53, 0.14, sub, ha="center", va="center", fontsize=6.5, color=CR_GRIS)

    def medidor(fig, x, y, w, h, titulo, valor, color, sub, escala_txt, margen=None):
        from matplotlib.patches import Wedge
        ax = tarjeta(fig, x, y, w, h)
        ax.text(0.5, 0.90, titulo.upper(), ha="center", va="center", fontsize=7.5, color=CR_AZUL, weight="bold")
        g = fig.add_axes([x + w * 0.12, y + h * 0.20, w * 0.76, h * 0.62])
        g.set_xlim(-1.15, 1.15); g.set_ylim(-0.25, 1.1); g.axis("off"); g.set_aspect("equal")
        g.add_patch(Wedge((0, 0), 1, 0, 180, width=0.26, color="#e6ecf2"))
        frac = max(0.0, min(1.0, valor / 100.0))
        g.add_patch(Wedge((0, 0), 1, 180 - 180 * frac, 180, width=0.26, color=color))
        g.text(0, 0.24 if margen is not None else 0.18, "%.1f%%" % valor, ha="center", va="center", fontsize=17,
               weight="bold", color=CR_MARINO)
        if margen is not None:
            g.text(0, -0.02, "± %.1f" % margen, ha="center", va="center", fontsize=9.5, weight="bold", color=CR_AZUL)
        g.text(-0.87, -0.15, "0", ha="center", fontsize=6, color=CR_GRIS)
        g.text(0.87, -0.15, "100", ha="center", fontsize=6, color=CR_GRIS)
        ax.text(0.5, 0.15, sub, ha="center", va="center", fontsize=7, color=CR_GRIS)
        ax.text(0.5, 0.05, escala_txt, ha="center", va="center", fontsize=5.8, color="#8a96a3")
        ax.add_patch(plt.Rectangle((0, 0.97), 1, 0.03, color=color, clip_on=False))

    def titulo_bloque(fig, x, y, texto):
        fig.add_artist(plt.Rectangle((x, y - 0.006), 0.004, 0.024, color=CR_AZUL, transform=fig.transFigure))
        fig.text(x + 0.01, y + 0.006, texto, fontsize=10, weight="bold", color=CR_MARINO, va="center")

    def tabla(fig, rect, enc, filas_t, fs=7, total=False, colores_celda=None, anchos=None):
        axt = fig.add_axes(rect); axt.axis("off")
        cw = None
        if anchos:
            cw = [a / float(sum(anchos)) for a in anchos]
        tb = axt.table(cellText=filas_t, colLabels=enc, cellLoc="center", bbox=[0, 0, 1, 1], colWidths=cw)
        tb.auto_set_font_size(False)
        tb.set_fontsize(fs)
        n_filas = len(filas_t)
        for (r, c), cel in tb.get_celld().items():
            cel.set_edgecolor(CR_BORDE)
            cel.set_linewidth(0.6)
            if r == 0:
                cel.set_facecolor(CR_MARINO)
                cel.set_text_props(color="white", weight="bold")
                cel.set_height(cel.get_height() * 2.0)
            elif total and r == n_filas:
                cel.set_facecolor("#dcebf8")
                cel.set_text_props(weight="bold", color=CR_MARINO)
            else:
                cel.set_facecolor("white" if r % 2 else "#f2f6fa")
                cel.set_text_props(color="#1f2a37")
                if colores_celda and (r - 1, c) in colores_celda:
                    cel.set_text_props(color=colores_celda[(r - 1, c)], weight="bold")
        return tb

    def estilo_ejes(ax, grid="y"):
        ax.set_facecolor("white")
        for k in ("top", "right"):
            ax.spines[k].set_visible(False)
        for k in ("left", "bottom"):
            ax.spines[k].set_color("#9aa8b8")
        ax.tick_params(labelsize=7, colors="#3d4b5c")
        if grid:
            ax.grid(axis=grid, color="#e3e9f0", lw=0.8)
        ax.set_axisbelow(True)

    def ticks_vuelo(ax, n):
        paso = 1 if len(n) <= 30 else int(math.ceil(len(n) / 30.0))
        ax.set_xticks(n[::paso])
        ax.tick_params(axis="x", labelsize=6.3)

    def escala(ax):
        x0, x1 = ax.get_xlim(); y0, y1 = ax.get_ylim()
        largo = 10 ** math.floor(math.log10((x1 - x0) / 4))
        for m in (5, 2, 1):
            if m * largo <= (x1 - x0) / 4:
                largo *= m
                break
        bx, by = x0 + 0.04 * (x1 - x0), y0 + 0.035 * (y1 - y0)
        ax.plot([bx, bx + largo], [by, by], color=CR_MARINO, lw=4.6, solid_capstyle="butt")
        ax.plot([bx + largo / 2, bx + largo], [by, by], color="white", lw=3.0, solid_capstyle="butt")
        txt = ("%g km" % (largo / 1000)) if largo >= 1000 else ("%g m" % largo)
        ax.text(bx + largo / 2, by + 0.018 * (y1 - y0), txt, ha="center", fontsize=7, color=CR_MARINO)
        ax.annotate("N", xy=(x1 - 0.03 * (x1 - x0), y1 - 0.01 * (y1 - y0)),
                    xytext=(x1 - 0.03 * (x1 - x0), y1 - 0.065 * (y1 - y0)),
                    ha="center", fontsize=9, weight="bold", color=CR_MARINO,
                    arrowprops=dict(arrowstyle="-|>", color=CR_MARINO, lw=1.2))

    def ajustar_vista(ax, ext, rect_fig):
        """Encaja la extensión en el eje respetando escala 1:1 y dejando aire para escala y norte."""
        x0, x1, y0, y1 = ext
        w, h = x1 - x0, y1 - y0
        pad = 0.05 * max(w, h)
        x0, x1, y0, y1 = x0 - pad, x1 + pad, y0 - pad - 0.10 * max(w, h), y1 + pad + 0.07 * max(w, h)
        w, h = x1 - x0, y1 - y0
        asp_ax = (rect_fig[3] * A4[1]) / (rect_fig[2] * A4[0])
        if h / w < asp_ax:
            d = (w * asp_ax - h) / 2
            y0, y1 = y0 - d, y1 + d
        else:
            d = (h / asp_ax - w) / 2
            x0, x1 = x0 - d, x1 + d
        ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect("equal")
        ax.set_xticks([]); ax.set_yticks([])
        escala(ax)

    def mapa_ax(fig, rect):
        ax = fig.add_axes(list(rect))
        ax.set_facecolor("white")
        for s in ax.spines.values():
            s.set_color(CR_BORDE)
        return ax

    def contorno(ax, T, lw=1.0):
        for an in T["anillos"]:
            ax.plot(an[:, 0], an[:, 1], color=CR_MARINO, lw=lw)

    def leyenda_clases(ax, ncol=3):
        h = [Patch(color=COL[i], label=NOM[i]) for i in range(1, 6)]
        ax.legend(handles=h, loc="upper center", bbox_to_anchor=(0.5, -0.005), ncol=ncol, fontsize=6.8,
                  frameon=False, handlelength=1.1, columnspacing=0.9)

    def etiqueta_clase_dosis(i):
        if TASA_VARIADA:
            a, b = BR[i] * 100, BR[i + 1] * 100
            return "%s %s" % (NOM_D[i], ("> %.0f%%" % a) if b > 1e8 else ("%.0f–%.0f%%" % (a, b)))
        a, b = bordes[i], bordes[i + 1]
        return "%s %s" % (NOM_D[i], ("> %.1f" % a) if b > 1e8 else ("%.1f–%.1f" % (a, b)))

    def leyenda_dosis(ax, ncol=4):
        h = [Patch(color=PAL_D[i], label=etiqueta_clase_dosis(i)) for i in range(len(BR) - 1)]
        h.append(Patch(color="#d3dbe4", label="Sin aplicación"))
        ax.legend(handles=h, loc="upper center", bbox_to_anchor=(0.5, -0.005), ncol=ncol, fontsize=6.6, frameon=False,
                  title=("Dosis aplicada / prescrita" if TASA_VARIADA else "Dosis (L/%.0s§)" % U_TXT), title_fontsize=6.8,
                  handlelength=1.1, columnspacing=0.9)

    def nombre_t(T):
        return "Tablón %s" % T["nombre"] if not T["nombre"].startswith(("Lote", "Área")) else T["nombre"]

    # ---- hallazgos automáticos ----
    hallazgos = ["Se %s con %.2f %s; se cubrió el %.1f%% del área con %d vuelos y %.1f L de mezcla."
                 % ("evaluó 1 tablón" if len(tablones) == 1 else "evaluaron %d tablones" % len(tablones),
                    a_unidad(A_lote), U_TXT, cobertura, len(vuelos), L_tot)]
    criticos = sorted([T for T in tablones if pct(T["A_no"], T["A_lote"]) > 5],
                      key=lambda T: -pct(T["A_no"], T["A_lote"]))
    if criticos and len(tablones) == 1:
        txt_h = "Área sin aplicar de %.2f %s (%.1f%% del tablón)." % (a_unidad(A_no), U_TXT, pct(A_no, A_lote))
        if len(tablones[0]["piezas"]) > 1:
            peor = max(tablones[0]["piezas"], key=lambda p: pct(p["no"], p["area"]))
            txt_h += " La pieza %s concentra la falla con %.1f%% de su superficie sin cubrir." % (
                peor["pieza"], pct(peor["no"], peor["area"]))
        hallazgos.append(txt_h)
    elif criticos:
        hallazgos.append("Área sin aplicar de %.2f %s. Tablones con más de 5%% sin cubrir: %s." % (
            a_unidad(A_no), U_TXT, ", ".join("%s (%.1f%%)" % (T["nombre"], pct(T["A_no"], T["A_lote"])) for T in criticos[:6])
            + (" y %d más" % (len(criticos) - 6) if len(criticos) > 6 else "")))
        if len(tablones) == 1 and tablones[0]["piezas"]:
            peor = max(tablones[0]["piezas"], key=lambda p: pct(p["no"], p["area"]))
            hallazgos.append("Dentro del tablón, la pieza %s concentra la falla con %.1f%% de su superficie sin cubrir."
                             % (peor["pieza"], pct(peor["no"], peor["area"])))
    else:
        hallazgos.append(("El tablón tiene" if len(tablones) == 1 else "Todos los tablones tienen") + " menos de 5%% de su área sin aplicar (total %.2f %s)." % (a_unidad(A_no), U_TXT))
    hallazgos.append("Sobreaplicación en %.1f%% del área (%.2f %s); exceso de producto por traslapes estimado en %.1f L."
                     % (pct(A_sob, A_lote), a_unidad(A_sob), U_TXT, L_exceso))
    if DOSIS_OBJETIVO:
        hallazgos.append("Dosis media en el área cubierta de %.2f L/%.0s§, %+.1f%% respecto al objetivo de %.2f L/%.0s§; CV de %.1f%%."
                         % (dosis_media_cub, U_TXT, (dosis_media_cub - DOSIS_OBJETIVO) / DOSIS_OBJETIVO * 100,
                            DOSIS_OBJETIVO, U_TXT, cv))
    else:
        hallazgos.append("Dosis media en el área cubierta de %.2f L/%.0s§ (%.1f L/ha) con CV de %.1f%%."
                         % (dosis_media_cub, U_TXT, dosis_media_cub / M2_POR_UNIDAD * 1e4, cv))
    if TASA_VARIADA:
        desv = [v for v in vuelos if np.isfinite(v["factor"]) and abs(v["factor"] - 1) > tol]
    else:
        desv = [v for v in vuelos if abs(v["dosis_calc_L_m2"] * M2_POR_UNIDAD - ref) / ref > tol]
    if desv and TASA_VARIADA:
        hallazgos.append("%d vuelo(s) aplicaron fuera de ±%g%% de lo prescrito: %s." % (len(desv), TOLERANCIA_DOSIS, ", ".join(
            "#%d (%+.0f%%)" % (v["n"], (v["factor"] - 1) * 100) for v in desv[:5]) + (" y %d más" % (len(desv) - 5) if len(desv) > 5 else "")))
    elif desv:
        hallazgos.append("%d vuelo(s) con dosis fuera de ±%g%% de la referencia: %s." % (len(desv), TOLERANCIA_DOSIS, ", ".join(
            "#%d (%.2f)" % (v["n"], v["dosis_calc_L_m2"] * M2_POR_UNIDAD) for v in desv[:8]) + (" …" if len(desv) > 8 else "")))
    else:
        hallazgos.append("Todos los vuelos aplicaron dentro de ±%g%% de la dosis de referencia." % TOLERANCIA_DOSIS)
    if TASA_VARIADA:
        fv_ = [v["factor"] for v in vuelos if np.isfinite(v["factor"])]
        hallazgos.append("Tasa variada: se aplicaron %.1f L frente a %.1f L prescritos en los tablones (%+.1f%%); factor de "
                         "calibración de los vuelos entre %.2f y %.2f." % (L_in, L_presc, pct(L_in - L_presc, L_presc),
                                                                          min(fv_), max(fv_)))
    hallazgos.append("%.1f L (%.1f%%) cayeron en calles o fuera de los tablones evaluados."
                     % (L_calle + L_fuera, pct(L_calle + L_fuera, L_tot)))
    if not multi_dia:
        hallazgos.append("Jornada de %.1f h con %.1f h de vuelo efectivo (%.0f%%); rendimiento de %.1f %s/h de jornada."
                         % (jornada_h, t_total / 3600, pct(t_total / 3600, jornada_h), rend_jornada, U_TXT))

    with PdfPages(pdf_path) as pdf:
        # =========================== PORTADA ===========================
        fig = plt.figure(figsize=A4)
        fondo(fig)
        poner_logo(fig, 0.047, 0.745, 0.19)
        fig.text(0.047, 0.625, "Informe de calidad de aplicación", fontsize=42, weight="bold", color=CR_MARINO, va="center")
        fig.text(0.047, 0.525, "Área de Agricultura de Precisión", fontsize=17, weight="bold", color=CR_AZUL, va="center")
        fig.text(0.047, 0.478, "Departamento de Investigaciones Agrícolas", fontsize=15, color=CR_GRIS, va="center")
        fig.text(0.047, 0.395, fecha_informe, fontsize=13, color=CR_MARINO,
                 va="center")
        bandas(fig, 0.225)
        pdf.savefig(fig, facecolor=fig.get_facecolor()); plt.close(fig)

        # =========================== RESUMEN ===========================
        fig = plt.figure(figsize=A4)
        encabezado(fig, "Resumen", "Aplicación del %s  ·  %s  ·  %d vuelos  ·  Equipo(s): %s"
                   % (fecha_apl, "1 tablón" if len(tablones) == 1 else "%d tablones" % len(tablones), len(vuelos),
                      ", ".join(equipos) or "-"))
        # cobertura por tablón (o por pieza si es uno solo)
        if len(tablones) == 1:
            T0 = tablones[0]
            titulo_bloque(fig, 0.04, 0.81, "Cobertura por pieza")
            etiqs = ["P-%s" % p["pieza"] for p in T0["piezas"]]
            trip = [(p["apl"], p["sob"], p["no"], p["area"]) for p in T0["piezas"]]
        else:
            titulo_bloque(fig, 0.04, 0.81, "Cobertura por tablón" + (" (12 de menor cobertura)" if len(tablones) > 12 else ""))
            orden = sorted(tablones, key=lambda T: pct(T["A_apl"] + T["A_sob"], T["A_lote"]))[:12]
            etiqs = [T["nombre"] for T in orden]
            trip = [(T["A_apl"], T["A_sob"], T["A_no"], T["A_lote"]) for T in orden]
        etiqs.append("Total")
        trip.append((A_apl, A_sob, A_no, A_lote))
        alto_p = min(0.62, 0.06 * len(etiqs) + 0.06)
        axp = fig.add_axes([0.10, 0.76 - alto_p, 0.37, alto_p])
        estilo_ejes(axp, grid="x")
        ap = [pct(a, t) for a, s, n_, t in trip]
        sp = [pct(s, t) for a, s, n_, t in trip]
        npc = [pct(n_, t) for a, s, n_, t in trip]
        yy_ = np.arange(len(etiqs))[::-1]
        axp.barh(yy_, ap, color=COL[1], height=0.62, label="Aplicado")
        axp.barh(yy_, sp, left=ap, color=COL[2], height=0.62, label="Sobreaplicado")
        axp.barh(yy_, npc, left=np.add(ap, sp), color=COL[3], height=0.62, label="No aplicado")
        for yv, a_, s_, n_ in zip(yy_, ap, sp, npc):
            axp.text(2, yv, "%.0f%%" % (a_ + s_), va="center", fontsize=8.5, color="white", weight="bold")
            if n_ > 7:
                axp.text(a_ + s_ + n_ / 2, yv, "%.0f%%" % n_, va="center", ha="center", fontsize=8.5, color=CR_MARINO)
        axp.set_yticks(yy_); axp.set_yticklabels(etiqs, fontsize=8.5)
        axp.set_xlim(0, 100); axp.set_xlabel("% del área", fontsize=8.5, color=CR_MARINO)
        axp.legend(fontsize=8, frameon=False, ncol=3, loc="lower center", bbox_to_anchor=(0.45, 1.0))

        titulo_bloque(fig, 0.54, 0.81, "Destino del producto aplicado")
        partes_b = [("Útil en tablones", L_util, CR_AZUL), ("Exceso por traslape", L_exceso, CR_ROJO),
                    ("En calles", L_calle, COL[4]), ("Fuera de tablones", L_fuera, COL[5])]
        axb = fig.add_axes([0.55, 0.64, 0.41, 0.12]); axb.axis("off")
        izq = 0.0
        for nom_b, val_b, col_b in partes_b:
            axb.barh(0.5, val_b, left=izq, color=col_b, height=0.8)
            izq += val_b
        axb.set_xlim(0, L_tot); axb.set_ylim(0, 1)
        axb.text(L_util / 2, 0.5, "%.1f%% útil" % pct(L_util, L_tot), ha="center", va="center", fontsize=12,
                 color="white", weight="bold")
        for i, (nom_b, val_b, col_b) in enumerate(partes_b):
            r_, c_ = divmod(i, 2)
            kpi(fig, 0.55 + c_ * 0.21, 0.40 - r_ * 0.19, 0.20, 0.16, nom_b, "%.1f L" % val_b,
                "%.1f%% del total aplicado" % pct(val_b, L_tot), acento=col_b, fs=16)
        fig.text(0.55, 0.13, "Total aplicado: %.1f L en %d vuelos" % (L_tot, len(vuelos)), fontsize=10,
                 color=CR_MARINO, weight="bold")
        cerrar_pagina(pdf, fig)

        # =========================== TRAZAS DE VUELO (KML) ===========================
        # clasificacion de toda la traza: aplicacion / giros / traslados (despegue, ida y regreso)
        km = {"apl": 0.0, "giro": 0.0, "tras": 0.0}
        por_vuelo = []
        tramos_dib = []
        for v in vuelos:
            L, _ang = rumbos(v["xy"])
            p_ = v["es_pasada"]
            tipo = np.where(p_, 0, 2)
            j = 0
            while j < len(p_):
                if p_[j]:
                    j += 1
                    continue
                k2 = j
                while k2 < len(p_) and not p_[k2]:
                    k2 += 1
                if L[j:k2].sum() <= 3 * v["ancho_m"] and j > 0 and k2 < len(p_):
                    tipo[j:k2] = 1
                j = k2
            d_v = [L[tipo == t].sum() for t in (0, 1, 2)]
            por_vuelo.append(d_v)
            km["apl"] += d_v[0]; km["giro"] += d_v[1]; km["tras"] += d_v[2]
            tramos_dib.append((v, tipo))
        km_tot = sum(km.values())
        hallazgos.insert(1, "El drone recorrió %.1f km: %.0f%% aplicando, %.0f%% en despegues, idas y regresos y %.0f%% en giros."
                         % (km_tot / 1000, pct(km["apl"], km_tot), pct(km["tras"], km_tot), pct(km["giro"], km_tot)))
        COL_T = {0: VERDE, 1: AMBAR, 2: CR_ROJO}
        fig = plt.figure(figsize=A4)
        encabezado(fig, "Trazas de vuelo", "Todo lo que registró el drone en los KML, clasificado por tipo de tramo")
        rmap = (0.04, 0.11, 0.50, 0.72)
        ax = mapa_ax(fig, rmap)
        for T in tablones:
            contorno(ax, T, lw=1.0)
        for v, tipo in tramos_dib:
            xy = v["xy"]
            for j in range(len(tipo)):
                t_ = tipo[j]
                ax.plot(xy[j:j + 2, 0], xy[j:j + 2, 1], color=COL_T[t_], lw=1.0 if t_ == 0 else 0.9,
                        ls="-" if t_ != 2 else (0, (4, 3)), alpha=0.9, solid_capstyle="butt")
        homes = np.array([v["xy"][0] for v in vuelos])
        ax.plot(homes[:, 0], homes[:, 1], "^", color=CR_MARINO, ms=6.5, mec="white", mew=0.8)
        todos_xy = np.vstack([np.vstack(T["anillos"]) for T in tablones if T["anillos"]] + [v["xy"] for v in vuelos])
        ajustar_vista(ax, (todos_xy[:, 0].min(), todos_xy[:, 0].max(), todos_xy[:, 1].min(), todos_xy[:, 1].max()), rmap)
        ax.legend(handles=[plt.Line2D([], [], color=VERDE, lw=2, label="Aplicación (pasadas)"),
                           plt.Line2D([], [], color=AMBAR, lw=2, label="Giros en cabecera"),
                           plt.Line2D([], [], color=CR_ROJO, lw=1.5, ls="--", label="Despegue, ida y regreso"),
                           plt.Line2D([], [], color=CR_MARINO, marker="^", ls="", ms=6, label="Punto de despegue")],
                  loc="upper center", bbox_to_anchor=(0.5, -0.005), ncol=4, fontsize=7, frameon=False,
                  handlelength=1.6, columnspacing=1.0)

        titulo_bloque(fig, 0.575, 0.81, "Distancia recorrida por tipo de tramo")
        axd = fig.add_axes([0.585, 0.53, 0.17, 0.25])
        vals_t = [km["apl"], km["giro"], km["tras"]]
        cols_t = [VERDE, AMBAR, CR_ROJO]
        axd.pie(vals_t, colors=cols_t, startangle=90, counterclock=False,
                wedgeprops=dict(width=0.36, edgecolor=CR_FONDO, linewidth=1.5))
        axd.text(0, 0.08, "%.0f%%" % pct(km["apl"], km_tot), ha="center", va="center", fontsize=16, weight="bold",
                 color=CR_MARINO)
        axd.text(0, -0.22, "aplicando", ha="center", va="center", fontsize=7.5, color=CR_GRIS)
        noms_t = ["Aplicación", "Giros", "Despegue, ida y regreso"]
        for i, (nm, val_, col_) in enumerate(zip(noms_t, vals_t, cols_t)):
            y_ = 0.735 - i * 0.07
            fig.add_artist(plt.Rectangle((0.775, y_ - 0.008), 0.012, 0.022, color=col_, transform=fig.transFigure))
            fig.text(0.795, y_ + 0.01, nm, fontsize=8.5, color=CR_MARINO, weight="bold", va="center")
            fig.text(0.795, y_ - 0.014, "%.1f km  ·  %.1f%%" % (val_ / 1000, pct(val_, km_tot)), fontsize=8,
                     color=CR_GRIS, va="center")

        titulo_bloque(fig, 0.575, 0.44, "Recorrido de cada vuelo (km)")
        axv = fig.add_axes([0.61, 0.11, 0.35, 0.29])
        estilo_ejes(axv)
        nn_ = np.array([v["n"] for v in vuelos])
        pv = np.array(por_vuelo) / 1000
        axv.bar(nn_, pv[:, 0], color=VERDE, width=0.75, label="Aplicación")
        axv.bar(nn_, pv[:, 1], bottom=pv[:, 0], color=AMBAR, width=0.75, label="Giros")
        axv.bar(nn_, pv[:, 2], bottom=pv[:, 0] + pv[:, 1], color=CR_ROJO, width=0.75, label="Despegue, ida y regreso")
        axv.set_xlabel("Vuelo", fontsize=7.5, color=CR_MARINO)
        ticks_vuelo(axv, nn_)
        axv.legend(fontsize=6.5, frameon=False, loc="lower right", bbox_to_anchor=(1, 1.0), ncol=3)
        cerrar_pagina(pdf, fig)

        # =========================== RESUMEN POR TABLÓN ===========================
        enc = ["Tablón", "Piezas", "Área\n(%s)" % U_TXT, "Cobertura\n(%)", "No apl.\n(%s)" % U_TXT, "No apl.\n(%)",
               "Sobre\n(%)", "Litros", "Dosis\nL/%.0s§" % U_TXT, "CV\n(%)", "Unif.\n(%)", "Vuelos"]

        def rango_vuelos(lst):
            if not lst:
                return "-"
            partes, ini, prev = [], lst[0], lst[0]
            for x in lst[1:] + [None]:
                if x is not None and x == prev + 1:
                    prev = x
                    continue
                partes.append(str(ini) if ini == prev else "%d–%d" % (ini, prev))
                if x is not None:
                    ini = prev = x
            return ", ".join(partes)

        filas_tab = []
        colores = {}
        for T in tablones:
            r = len(filas_tab)
            cb = pct(T["A_apl"] + T["A_sob"], T["A_lote"])
            colores[(r, 3)] = semaforo(cb, 95, 85)
            colores[(r, 10)] = semaforo(T["unif"], 85, 70)
            filas_tab.append([T["nombre"], T["n_piezas"], "%.2f" % a_unidad(T["A_lote"]), "%.1f" % cb,
                              "%.2f" % a_unidad(T["A_no"]), "%.1f" % pct(T["A_no"], T["A_lote"]),
                              "%.1f" % pct(T["A_sob"], T["A_lote"]), "%.1f" % T["L_in"], "%.2f" % T["dosis_cub"],
                              "%.1f" % T["cv"], "%.1f" % T["unif"], rango_vuelos(T["vuelos"])])
        total_row = ["TOTAL", sum(T["n_piezas"] for T in tablones), "%.2f" % a_unidad(A_lote), "%.1f" % cobertura,
                     "%.2f" % a_unidad(A_no), "%.1f" % pct(A_no, A_lote), "%.1f" % pct(A_sob, A_lote), "%.1f" % L_in,
                     "%.2f" % dosis_media_cub, "%.1f" % cv, "%.1f" % unif, "%d" % len(vuelos)]
        POR_PAG = 26
        bloques = [filas_tab[i:i + POR_PAG] for i in range(0, len(filas_tab), POR_PAG)] or [[]]
        for b, bloque in enumerate(bloques if len(tablones) > 1 else []):
            fig = plt.figure(figsize=A4)
            encabezado(fig, "Resumen por tablón" + (" (%d/%d)" % (b + 1, len(bloques)) if len(bloques) > 1 else ""),
                       "Cobertura y dosis de cada tablón evaluado · semáforo en cobertura y uniformidad")
            filas_b = list(bloque)
            col_b = {(r - b * POR_PAG, c): v for (r, c), v in colores.items() if b * POR_PAG <= r < (b + 1) * POR_PAG}
            ultimo = b == len(bloques) - 1
            if ultimo:
                filas_b.append(total_row)
            alto = min(0.78, 0.028 * (len(filas_b) + 2))
            tabla(fig, [0.04, 0.84 - alto, 0.92, alto], enc, filas_b, fs=7.3, total=ultimo, colores_celda=col_b,
                  anchos=[1.1, 0.7, 0.9, 0.9, 0.9, 0.8, 0.8, 0.9, 0.8, 0.7, 0.8, 2.6])
            cerrar_pagina(pdf, fig)

        # =========================== FICHA POR TABLÓN ===========================
        for T in tablones:
            fig = plt.figure(figsize=A4)
            cb = pct(T["A_apl"] + T["A_sob"], T["A_lote"])
            encabezado(fig, nombre_t(T), "%d pieza(s)  ·  %.2f %s  ·  variedad(es): %s  ·  vuelos %s" % (
                T["n_piezas"], a_unidad(T["A_lote"]), U_TXT, ", ".join(T["variedades"]) or "-", rango_vuelos(T["vuelos"])))
            r1 = (0.04, 0.39, 0.445, 0.42)
            r2 = (0.515, 0.39, 0.445, 0.42)
            titulo_bloque(fig, 0.04, 0.83, "Cobertura")
            titulo_bloque(fig, 0.515, 0.83, "Dosis aplicada vs prescripción" if TASA_VARIADA else "Dosis aplicada")
            ax1 = mapa_ax(fig, r1)
            cm = ListedColormap(["#ffffff00"] + [COL[i] for i in range(1, 6)])
            ax1.imshow(np.ma.masked_equal(T["disp_clases"], 0), cmap=cm, norm=BoundaryNorm(np.arange(-0.5, 6.5), cm.N),
                       extent=T["disp_ext"], interpolation="nearest")
            contorno(ax1, T)
            ax2 = mapa_ax(fig, r2)
            cmd = ListedColormap(PAL_D)
            ax2.imshow(np.ma.masked_invalid(T["disp_razon"]), cmap=cmd, norm=BoundaryNorm(BR, cmd.N),
                       extent=T["disp_ext"], interpolation="nearest")
            ax2.imshow(np.ma.masked_where(T["disp_clases"] != 3, np.ones_like(T["disp_clases"])),
                       cmap=ListedColormap(["#d3dbe4"]), extent=T["disp_ext"], interpolation="nearest")
            contorno(ax2, T)
            if T["anillos"]:
                pts_t = np.vstack(T["anillos"])
                ext_t = (pts_t[:, 0].min(), pts_t[:, 0].max(), pts_t[:, 1].min(), pts_t[:, 1].max())
            else:
                ext_t = T["disp_ext"]
            for axm, rr in ((ax1, r1), (ax2, r2)):
                if len(T["piezas"]) > 1:
                    for p in T["piezas"]:
                        axm.text(p["xy"][0], p["xy"][1], "P-%s" % p["pieza"], fontsize=6.8, weight="bold", color=CR_MARINO,
                                 ha="center", va="center",
                                 bbox=dict(boxstyle="round,pad=0.2", fc="white", ec=CR_MARINO, lw=0.5, alpha=0.85))
                ajustar_vista(axm, ext_t, rr)
            leyenda_clases(ax1)
            leyenda_dosis(ax2)

            kw, kh = 0.142, 0.085
            fila = [
                ("Cobertura", "%.1f %%" % cb, "%.2f %s" % (a_unidad(T["A_apl"] + T["A_sob"]), U_TXT), semaforo(cb, 95, 85)),
                ("No aplicado", "%.1f %%" % pct(T["A_no"], T["A_lote"]), "%.2f %s" % (a_unidad(T["A_no"]), U_TXT), None),
                ("Sobreaplicado", "%.1f %%" % pct(T["A_sob"], T["A_lote"]), "%.2f %s" % (a_unidad(T["A_sob"]), U_TXT), None),
                ("Dosis cubierta", "%.2f L/%.0s§" % (T["dosis_cub"], U_TXT), "%.1f L/ha" % (T["dosis_cub"] / M2_POR_UNIDAD * 1e4), None),
                (("Unif. vs prescripción" if TASA_VARIADA else "Uniformidad"), "%.1f %%" % T["unif"], "CV %.1f %%" % T["cv"], semaforo(T["unif"], 85, 70)),
                ("Litros", "%.1f L" % T["L_in"], "%.1f L en calles" % T["L_calle"], None),
            ]
            for i, (t, val, sub, acento) in enumerate(fila):
                r, c = divmod(i, 3)
                kpi(fig, 0.04 + c * (kw + 0.006), 0.205 - r * (kh + 0.012), kw, kh, t, val, sub, acento, fs=12)
            if T["piezas"]:
                encp = ["Pieza", "Variedad", "Área\n(%s)" % U_TXT, "No apl.\n(%)", "Sobre\n(%)", "Dosis\nL/%.0s§" % U_TXT, "CV\n(%)", "Unif.\n(%)"]
                fp = [["P-" + p["pieza"], p["variedad"] or "-", "%.2f" % a_unidad(p["area"]), "%.1f" % pct(p["no"], p["area"]),
                       "%.1f" % pct(p["sob"], p["area"]), "%.2f" % p["dosis_cub"], "%.1f" % p["cv"], "%.1f" % p["unif"]]
                      for p in T["piezas"][:10]]
                alto = min(0.25, 0.022 * (len(fp) + 2))
                tabla(fig, [0.515, 0.29 - alto, 0.445, alto], encp, fp, fs=6.6)
                if len(T["piezas"]) > 10:
                    fig.text(0.515, 0.29 - alto - 0.015, "… %d piezas más en resumen_piezas.csv" % (len(T["piezas"]) - 10),
                             fontsize=6.5, color=CR_GRIS)
            cerrar_pagina(pdf, fig)

            # ---- tasa variada: prescripcion vs aplicacion ----
            if TASA_VARIADA and T.get("zonas"):
                fig = plt.figure(figsize=A4)
                encabezado(fig, nombre_t(T) + " · tasa variada", "Dosis prescrita (mapa de zonas) frente a la dosis aplicada estimada")
                r1 = (0.04, 0.40, 0.445, 0.41)
                r2 = (0.515, 0.40, 0.445, 0.41)
                titulo_bloque(fig, 0.04, 0.83, "Dosis prescrita (L/%.0s§)" % U_TXT)
                titulo_bloque(fig, 0.515, 0.83, "Dosis aplicada estimada (L/%.0s§)" % U_TXT)
                vals_p = T["disp_presc"][np.isfinite(T["disp_presc"])]
                vmin_ = float(np.nanmin(vals_p)) * 0.7 if vals_p.size else 0
                vmax_ = float(np.nanmax(vals_p)) * 1.3 if vals_p.size else 1
                cmap_c = plt.get_cmap("viridis_r")
                for rr, arr in ((r1, T["disp_presc"]), (r2, T["disp_dosis"])):
                    axm = mapa_ax(fig, rr)
                    im = axm.imshow(np.ma.masked_invalid(arr), cmap=cmap_c, vmin=vmin_, vmax=vmax_,
                                    extent=T["disp_ext"], interpolation="nearest")
                    contorno(axm, T)
                    if T["anillos"]:
                        pts_t = np.vstack(T["anillos"])
                        ajustar_vista(axm, (pts_t[:, 0].min(), pts_t[:, 0].max(), pts_t[:, 1].min(), pts_t[:, 1].max()), rr)
                    else:
                        ajustar_vista(axm, T["disp_ext"], rr)
                    cax = fig.add_axes([rr[0] + 0.05, rr[1] - 0.035, rr[2] - 0.1, 0.012])
                    cb_ = fig.colorbar(im, cax=cax, orientation="horizontal")
                    cb_.ax.tick_params(labelsize=7, colors=CR_GRIS)
                    cb_.outline.set_edgecolor(CR_BORDE)
                encz = ["Zona\n(L/%.0s§ presc.)" % U_TXT, "Área\n(%s)" % U_TXT, "Cubierta\n(%)", "Aplicada\n(L/%.0s§)" % U_TXT,
                        "Desviación\n(%)", "Litros\nprescritos", "Litros\naplicados", "En rango\n(%)"]
                fz, colz = [], {}
                for i_z, z in enumerate(T["zonas"][:10]):
                    dev = (z["aplicada"] / z["presc"] - 1) * 100 if z["presc"] else np.nan
                    colz[(i_z, 4)] = VERDE if abs(dev) <= TOLERANCIA_DOSIS else (CR_ROJO if dev > 0 else AMBAR)
                    fz.append(["%.2f" % z["presc"], "%.2f" % a_unidad(z["area"]), "%.1f" % pct(z["cub"], z["area"]),
                               "%.2f" % z["aplicada"], "%+.1f" % dev, "%.1f" % z["L_presc"], "%.1f" % z["L_apl"],
                               "%.1f" % z["unif"]])
                alto = min(0.25, 0.026 * (len(fz) + 2))
                titulo_bloque(fig, 0.04, 0.29, "Resultado por zona de manejo")
                tabla(fig, [0.04, 0.265 - alto, 0.58, alto], encz, fz, fs=7, colores_celda=colz)
                dif = pct(T["L_in"] - T["L_presc"], T["L_presc"])
                kpi(fig, 0.66, 0.15, 0.145, 0.12, "Litros prescritos", "%.1f L" % T["L_presc"], "para todo el tablón")
                kpi(fig, 0.815, 0.15, 0.145, 0.12, "Litros aplicados", "%.1f L" % T["L_in"], "%+.1f%% vs prescrito" % dif,
                    acento=VERDE if abs(dif) <= TOLERANCIA_DOSIS else CR_ROJO)
                cerrar_pagina(pdf, fig)

        # =========================== DESEMPEÑO POR VUELO ===========================
        fig = plt.figure(figsize=A4)
        encabezado(fig, "Desempeño por vuelo", "%d vuelos en orden cronológico" % len(vuelos))
        n = np.array([v["n"] for v in vuelos])
        dosis_v = np.array([v["dosis_calc_L_m2"] * M2_POR_UNIDAD for v in vuelos])
        rend_v = np.array([a_unidad(v["area_calc_m2"]) / (v["tiempo_s"] / 3600) if v["tiempo_s"] else np.nan for v in vuelos])
        efic_v = np.array([pct(v["L_dentro"], v["litros"]) for v in vuelos])
        series = [("Litros aplicados por vuelo", [v["litros"] for v in vuelos]),
                  ("Dosis por vuelo (L/%.0s§)" % U_TXT, dosis_v),
                  ("Área barrida por vuelo (%s): calculada vs equipo" % U_TXT, [a_unidad(v["area_calc_m2"]) for v in vuelos]),
                  ("Rendimiento en vuelo (%s/h) y producto dentro de tablones" % U_TXT, rend_v)]
        if TASA_VARIADA:
            dosis_v = np.array([v["factor"] * 100 for v in vuelos])
            series[1] = ("Factor de calibración por vuelo (% aplicado vs prescrito)", dosis_v)
        ref_b = 100.0 if TASA_VARIADA else ref
        anch = 0.7 if len(n) <= 60 else 0.9
        for i, (tit, ys) in enumerate(series):
            x_ax, y_ax = 0.07 + (i % 2) * 0.48, 0.50 - (i // 2) * 0.40
            titulo_bloque(fig, x_ax - 0.03, y_ax + 0.33, tit)
            axg = fig.add_axes([x_ax, y_ax, 0.40, 0.29])
            estilo_ejes(axg)
            if i == 1:
                colores_v = [VERDE if abs(d - ref_b) <= tol * ref_b else (CR_ROJO if d > ref_b else AMBAR) for d in dosis_v]
                axg.bar(n, ys, color=colores_v, width=anch)
                axg.axhline(ref_b, color=CR_MARINO, lw=1, ls="--",
                            label=("100% = lo prescrito" if TASA_VARIADA else "Referencia %.2f" % ref))
                axg.axhspan((1 - tol) * ref_b, (1 + tol) * ref_b, color=VERDE, alpha=0.10, label="±%g%%" % TOLERANCIA_DOSIS)
                axg.set_ylim(0, max(np.nanmax(ys), ref_b * (1 + tol)) * 1.2)
                axg.legend(fontsize=7, frameon=False, loc="lower right", bbox_to_anchor=(1, 1.0), ncol=2)
            elif i == 2:
                axg.bar(n, ys, color=CR_MARINO, width=anch, label="Calculada")
                axg.plot(n, [a_unidad(v["area_dji_ha"] * 1e4) for v in vuelos], "o", color=CR_ROJO, ms=3,
                         label="Área de tarea (equipo)")
                axg.legend(fontsize=7, frameon=False, loc="lower right", bbox_to_anchor=(1, 1.0), ncol=2)
            elif i == 3:
                axg.bar(n, ys, color=CR_MARINO, width=anch, label="Rendimiento")
                ax2 = axg.twinx()
                ax2.plot(n, efic_v, "o-", color=CR_ROJO, ms=2.5, lw=1, label="% litros dentro de tablones")
                ax2.set_ylim(0, 105)
                ax2.tick_params(labelsize=7, colors=CR_ROJO)
                ax2.spines["top"].set_visible(False)
                ax2.spines["right"].set_color(CR_ROJO)
                hl1, lb1 = axg.get_legend_handles_labels(); hl2, lb2 = ax2.get_legend_handles_labels()
                axg.legend(hl1 + hl2, lb1 + lb2, fontsize=7, frameon=False, loc="lower right",
                           bbox_to_anchor=(1, 1.0), ncol=2)
            else:
                axg.bar(n, ys, color=CR_AZUL, width=anch)
                axg.axhline(np.mean(ys), color=CR_MARINO, lw=1, ls=":")
                axg.text(n[-1] + 0.6, np.mean(ys), "prom.\n%.1f" % np.mean(ys), fontsize=6, color=CR_MARINO, va="center")
            axg.set_xlabel("Vuelo", fontsize=7.5, color=CR_MARINO)
            ticks_vuelo(axg, n)
        cerrar_pagina(pdf, fig)

        # =========================== OPERACIÓN ===========================
        fig = plt.figure(figsize=A4)
        encabezado(fig, "Operación de vuelo", "Área cubierta por cada vuelo y secuencia de la aplicación")
        rmap = (0.04, 0.10, 0.50, 0.73)
        ax = mapa_ax(fig, rmap)
        cmap_v = plt.get_cmap("tab20")
        for T in tablones:
            contorno(ax, T, lw=0.8)
        for v in vuelos:
            col_v = cmap_v((v["n"] - 1) % 20)
            xy = v["xy"]
            sel = np.where(v["es_pasada"])[0]
            for j in sel:
                ax.plot(xy[j:j + 2, 0], xy[j:j + 2, 1], color=col_v, lw=1.6 if len(tablones) == 1 else 1.0,
                        solid_capstyle="butt")
            if len(sel) and len(vuelos) <= 60:
                pts_v = np.vstack([xy[sel], xy[sel + 1]])
                ax.text(np.median(pts_v[:, 0]), np.median(pts_v[:, 1]), str(v["n"]), fontsize=6, weight="bold",
                        color="white", ha="center", va="center",
                        bbox=dict(boxstyle="circle,pad=0.2", fc=CR_MARINO, ec="white", lw=0.5))
        homes = np.array([v["xy"][0] for v in vuelos])
        ax.plot(homes[:, 0], homes[:, 1], "^", color=CR_ROJO, ms=6.5, mec="white", mew=0.8, label="Despegue")
        if len(tablones) > 1:
            for T in tablones:
                if T["anillos"]:
                    pts_t = np.vstack(T["anillos"])
                    ax.text(pts_t[:, 0].mean(), pts_t[:, 1].max(), T["nombre"], fontsize=6.5, color=CR_MARINO,
                            weight="bold", ha="center", va="bottom")
        todos_xy = np.vstack([np.vstack(T["anillos"]) for T in tablones if T["anillos"]] +
                             [v["xy"][np.r_[v["es_pasada"], False] | np.r_[False, v["es_pasada"]]] for v in vuelos])
        ajustar_vista(ax, (todos_xy[:, 0].min(), todos_xy[:, 0].max(), todos_xy[:, 1].min(), todos_xy[:, 1].max()), rmap)
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.005), fontsize=7, frameon=False)
        ax.text(0.5, -0.06, "Cada color es un vuelo; el número indica el orden cronológico", transform=ax.transAxes,
                ha="center", fontsize=7, color=CR_GRIS)

        titulo_bloque(fig, 0.575, 0.81, "Cronograma de vuelos")
        axg = fig.add_axes([0.62, 0.43, 0.34, 0.35])
        estilo_ejes(axg, grid="x")
        if f_ini:
            t0 = f_ini
            span_h = max(jornada_h, 0.1)
            for v in vuelos:
                if not v["fecha"]:
                    continue
                ini = (v["fecha"] - t0).total_seconds() / 3600
                axg.barh(v["n"], v["tiempo_s"] / 3600, left=ini, color=cmap_v((v["n"] - 1) % 20), height=0.7,
                         edgecolor=CR_MARINO, lw=0.4)
            axg.invert_yaxis()
            if multi_dia:
                axg.set_xlabel("Horas desde %s" % t0.strftime("%d/%m %H:%M"), fontsize=7, color=CR_MARINO)
            else:
                ticks = np.arange(0, math.ceil(span_h) + 0.01, 0.5 if span_h <= 6 else 1)
                axg.set_xticks(ticks)
                axg.set_xticklabels([(t0 + dt.timedelta(hours=float(t))).strftime("%H:%M") for t in ticks], fontsize=6.5)
            axg.set_xlim(0, span_h * 1.02)
        axg.set_ylabel("Vuelo", fontsize=7.5, color=CR_MARINO)
        nv_ = [v["n"] for v in vuelos]
        axg.set_yticks(nv_[::max(1, int(math.ceil(len(nv_) / 30.0)))])
        axg.tick_params(axis="y", labelsize=5.8 if len(vuelos) > 20 else 6.5)

        kw = 0.108
        kpi(fig, 0.625, 0.235, kw, 0.10, "Jornada" if not multi_dia else "Período",
            ("%.1f h" % jornada_h) if not multi_dia else fecha_apl.replace(" – ", "–"),
            ("%s – %s" % (f_ini.strftime("%H:%M"), max(fin_vuelo).strftime("%H:%M"))) if (f_ini and not multi_dia) else "",
            fs=13 if not multi_dia else 8)
        kpi(fig, 0.625 + kw + 0.008, 0.235, kw, 0.10, "Tiempo de vuelo", "%.1f h" % (t_total / 3600),
            ("%.0f%% de la jornada" % pct(t_total / 3600, jornada_h)) if not multi_dia else "")
        kpi(fig, 0.625 + 2 * (kw + 0.008), 0.235, kw, 0.10, "Rendimiento en vuelo",
            "%.1f %s/h" % (a_unidad(A_barrida) / (t_total / 3600) if t_total else 0, U_TXT),
            ("%.1f %s/h de jornada" % (rend_jornada, U_TXT)) if not multi_dia else "")
        kpi(fig, 0.625, 0.12, kw, 0.10, "Vuelos", "%d" % len(vuelos), "%.1f L promedio" % (L_tot / len(vuelos)))
        kpi(fig, 0.625 + kw + 0.008, 0.12, kw, 0.10, "Altura / velocidad",
            "%.1f m · %.1f m/s" % (np.nanmean([v["altura"] for v in vuelos]), np.nanmean([v["velocidad"] for v in vuelos])),
            "programadas", fs=11)
        kpi(fig, 0.625 + 2 * (kw + 0.008), 0.12, kw, 0.10, "Ancho de faja",
            "%.2f m" % np.mean([v["ancho_m"] for v in vuelos]), "Route Spacing")
        cerrar_pagina(pdf, fig)

        # =========================== DOSIS Y PASADAS (global) ===========================
        fig = plt.figure(figsize=A4)
        encabezado(fig, "Distribución de la dosis",
                   ("Todos los tablones evaluados · dosis aplicada frente a lo prescrito en cada zona" if TASA_VARIADA else
                    "Todos los tablones evaluados · referencia %.2f L/%.0s§ (%.1f L/ha)" % (ref, U_TXT, ref / M2_POR_UNIDAD * 1e4)))
        titulo_bloque(fig, 0.04, 0.81, "Área por clase de dosis")
        axq = fig.add_axes([0.16, 0.13, 0.42, 0.64])
        estilo_ejes(axq, grid="x")
        areas_c = [hist_dosis[0] * cel_u]
        etq_c = ["Sin aplicación"]
        cols_c = ["#d3dbe4"]
        edges = np.r_[np.arange(nbins_h + 1) * 3.0 / nbins_h, np.inf]
        vals_h = hist_dosis[1:]
        for i in range(6):
            lo_, hi_ = BR[i], BR[i + 1]
            msk = (edges[:-1] >= lo_ - 1e-9) & (edges[:-1] < hi_ - 1e-9)
            areas_c.append(vals_h[msk].sum() * cel_u)
            etq_c.append(etiqueta_clase_dosis(i))
            cols_c.append(PAL_D[i])
        yq = np.arange(len(areas_c))[::-1]
        axq.barh(yq, areas_c, color=cols_c, height=0.65)
        for yv, a_c in zip(yq, areas_c):
            axq.text(a_c, yv, "  %.2f %s (%.1f%%)" % (a_c, U_TXT, pct(a_c, a_unidad(A_lote))), va="center", fontsize=8.5,
                     color=CR_MARINO)
        axq.set_yticks(yq); axq.set_yticklabels(etq_c, fontsize=8.5)
        axq.set_xlim(0, max(areas_c) * 1.45)
        axq.set_xlabel(U_TXT, fontsize=9, color=CR_MARINO)

        titulo_bloque(fig, 0.64, 0.81, "Indicadores de área")
        fila = [
            ("Área evaluada", "%.2f %s" % (a_unidad(A_lote), U_TXT), "%.2f ha" % (A_lote / 1e4), None),
            ("En calles", "%.2f %s" % (a_unidad(A_calle), U_TXT), "%.1f L" % L_calle, None),
            ("Fuera de tablones", "%.2f %s" % (a_unidad(A_fuera), U_TXT), "%.1f L" % L_fuera, None),
            ("Área barrida", "%.2f %s" % (a_unidad(A_barrida), U_TXT), "Equipo: %.2f %s" % (a_unidad(A_dji), U_TXT), None),
            ("Dosis efectiva", "%.2f L/%.0s§" % (dosis_efectiva_lote, U_TXT), "litros / área evaluada", None),
            (("Litros prescritos", "%.1f L" % L_presc, "aplicados: %.1f L (%+.1f%%)" % (L_in, pct(L_in - L_presc, L_presc)), None)
             if TASA_VARIADA else
             ("Dosis objetivo", ("%.2f L/%.0s§" % (DOSIS_OBJETIVO, U_TXT)) if DOSIS_OBJETIVO else "no definida",
              "ref. = promedio real" if not DOSIS_OBJETIVO else "", None)),
        ]
        for i, (t, val, sub, acento) in enumerate(fila):
            r, c = divmod(i, 2)
            kpi(fig, 0.645 + c * 0.16, 0.64 - r * 0.17, 0.15, 0.145, t, val, sub, acento, fs=13)
        cerrar_pagina(pdf, fig)

        # =========================== DETALLE POR VUELO ===========================
        enc = ["#", "Inicio", "Dur.\n(min)", "Tablón(es)", "Altura\n(m)", "Faja\n(m)", "Área equipo\n(%s)" % U_TXT,
               "Área calc.\n(%s)" % U_TXT, "Litros", "Dosis\nL/%.0s§" % U_TXT, "Dosis\nL/ha", "L en\ntablones"]
        filas_v = []
        for v in vuelos:
            tabs_v = ", ".join(v["tablones"]) or "-"
            filas_v.append([v["n"], v["fecha"].strftime("%d/%m %H:%M" if multi_dia else "%H:%M") if v["fecha"] else "",
                            "%.1f" % (v["tiempo_s"] / 60), tabs_v if len(tabs_v) <= 22 else tabs_v[:20] + "…",
                            "%.1f" % v["altura"], "%.2f" % v["ancho_m"],
                            "%.2f" % a_unidad(v["area_dji_ha"] * 1e4), "%.2f" % a_unidad(v["area_calc_m2"]),
                            "%.1f" % v["litros"], "%.2f" % (v["dosis_calc_L_m2"] * M2_POR_UNIDAD),
                            "%.1f" % (v["dosis_calc_L_m2"] * 1e4), "%.1f" % v["L_dentro"]])
        total_v = ["", "TOTAL", "%.0f" % (t_total / 60), "%d" % len(tablones), "", "", "%.2f" % a_unidad(A_dji),
                   "%.2f" % a_unidad(A_barrida), "%.1f" % L_tot, "%.2f" % dosis_global,
                   "%.1f" % (dosis_global / M2_POR_UNIDAD * 1e4), "%.1f" % L_in]
        POR_PAG = 30
        bloques = [filas_v[i:i + POR_PAG] for i in range(0, len(filas_v), POR_PAG)]
        for b, bloque in enumerate(bloques):
            fig = plt.figure(figsize=A4)
            encabezado(fig, "Detalle por vuelo" + (" (%d/%d)" % (b + 1, len(bloques)) if len(bloques) > 1 else ""),
                       "Parámetros registrados por el drone y resultados calculados")
            filas_b = list(bloque)
            ultimo = b == len(bloques) - 1
            if ultimo:
                filas_b.append(total_v)
            alto = min(0.78, 0.0245 * (len(filas_b) + 2))
            tabla(fig, [0.04, 0.84 - alto, 0.92, alto], enc, filas_b, fs=7, total=ultimo,
                  anchos=[0.5, 1.0, 0.7, 1.9, 0.7, 0.7, 0.9, 0.9, 0.8, 0.8, 0.8, 0.9])
            cerrar_pagina(pdf, fig)




    print("\n================ RESUMEN ================")
    print("%d tablones | %d vuelos | %.1f L" % (len(tablones), len(vuelos), L_tot))
    print("Area evaluada        : %.2f %s (%.2f ha)" % (a_unidad(A_lote), U_TXT, A_lote / 1e4))
    print("Aplicado (1 pasada)  : %.2f %s (%.1f %%)" % (a_unidad(A_apl), U_TXT, pct(A_apl, A_lote)))
    print("Sobreaplicado (>=2)  : %.2f %s (%.1f %%)" % (a_unidad(A_sob), U_TXT, pct(A_sob, A_lote)))
    print("No aplicado          : %.2f %s (%.1f %%)" % (a_unidad(A_no), U_TXT, pct(A_no, A_lote)))
    print("Area barrida calc/equipo: %.2f / %.2f %s" % (a_unidad(A_barrida), a_unidad(A_dji), U_TXT))
    print("Dosis area cubierta  : %.2f L/%.0sacre (%.2f L/ha)" % (dosis_media_cub, U_TXT, dosis_media_cub / M2_POR_UNIDAD * 1e4))
    print("CV dosis             : %.1f %% | Uniformidad: %.1f %%" % (cv, unif))
    print("Litros tablones / calles / fuera: %.1f / %.1f / %.1f" % (L_in, L_calle, L_fuera))
    print("Resultados en:", salida)


def _cargar_logo(base):
    """Usa logo_cr.png si existe en la carpeta; si no, el logo incluido en el script."""
    import base64
    import matplotlib.image as mpimg
    for cand in (os.path.join(base, "logo_cr.png"), os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo_cr.png")):
        if os.path.exists(cand):
            try:
                return mpimg.imread(cand)
            except Exception:
                pass
    try:
        return mpimg.imread(io.BytesIO(base64.b64decode(LOGO_CR_PNG_B64)), format="png")
    except Exception:
        return None


LOGO_CR_PNG_B64 = (
    "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"
    "JyHK9YrnYlfe7PrlLu9JSQ82+w8hXFpcvP7l9e9u3lxZWdF13el0nr9w4c23325oaGBYZtfXbPsA7hGxa9WP3Db+O+/U4vi2CyGE"
    "8vn8+PjY0uJSS0uLIAjXv/hydm72zNmXfvKTnzDs1uZw1lttZcntJhS2zcClqyiK8vDBw48+/NDGcX/9t3/T3Nxszpy4DlUmnRka"
    "HEwkkw0NDc0tzTabDctHk2n3+/t//atfBYPB//0P/xAMBg8yve/C3dLwRaPRjz74j/fefY9h2I6uTgIRIyMjv/3wI5a1/fXf/o3T"
    "6dRxiVh8YZIkaZomSRJCaBhG+SCSJElR1NLy0ru/+c3go0fnzp8LRyJWj60RsQ4oP5Eyocjy8sryzMx0KpWyNBZcf07X4/H4wsI8"
    "x3GNjU2SXZqfm3/8+HE6nW5sbrp48aLNZjMMAxqGWRAP0CRlvWNW+/iKEBb1TfwZ/2ddjgTAMI8paUc0TVMkaZgAZq6Y1WeKomhT"
    "XFl/wkwlCHwPFGVNDpaKtb629sUXX3z4Hx9qmtrQ1ESS5Njo6McffyKKovDWW1XVVebtGMhUJ4p9MAdQ26oBjG1oZoPWxmzWqFpH"
    "EmaekdVdPIYAUOb4m3YRfAvmnSKzRxQeDhxFhAfEGuqJ8fFPPvo4Flv3eDyWuPXn/Ha7ZObcF1soPRo8gLj0r156rNafsODcTYmx"
    "BPnUxIQgioV8fkupQ7qmz8xMf/bZZ6qqcpytvqGeYRhD1w2zt4lEYmpyUlEUrVjR8PnYXe5avZwcn/joww8Nw/iff//fT505beh6"
    "361bg48GKIqUZVlT1eGh4Ul8PTkUCnV2dTc1N83OzIyMjOTzeYIgkokkAERXd3dVVdXdu3fv9/dHo9H/eP/9qqqqxaWlRw8eeL2+"
    "zc0Nj8dz4uTJ6Fp0eHBIUVWe4xoaG3t6ewmCsLEsz/MUTZfkNGnC7nB0d3dfu/ZqVU312Ojov//6X6enp5cXF1VFyWVzgwMD42Oj"
    "BVl2uz3Hjh1rO3pE1/Xh4aG52TlRENLpNITQHwhwNm4tGs3l8w2NDV3d3U6HY2lpaXhoeHV1xYDQ5/Od7OmJRCLTU5ODg0Nerzeb"
    "za6trfEc193dfbK3V9f1B/cfjI6OZjMZjrPVReq6Txyvrq6mTKexpqpTU1P9d/spkrz2xhuXLl+iSOru3bvDQ8MUTemGns/lZmdn"
    "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"
    "/1ywyoZgl/lGAAAAAElFTkSuQmCC")


def _envolver(texto, ancho):
    out, linea = [], ""
    for p in texto.split():
        if len(linea) + len(p) + 1 > ancho:
            out.append(linea)
            linea = p
        else:
            linea = (linea + " " + p).strip()
    if linea:
        out.append(linea)
    return out


if __name__ == "__main__":
    main()
