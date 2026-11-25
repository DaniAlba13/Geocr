"""Agrega la zona de Kalil Hache (Lechugas, distrito 79, tablón 716, 142 piezas) a la cartografía base.
Uso: python tools/kalil_prep.py Mosaico_CR_26.shp BASE_DATOS_SUELOS_AREA_REVISADA.xlsx
Lee las geometrías del shp (piezas sin ADM_COL con ID_CR 16790716xxx) y los atributos de la hoja 'Hoja2'."""
import sys, os, json, struct, math
import numpy as np, cv2, openpyxl
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); S = lambda f: os.path.join(R, 'src', f)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shp_min import dbf, shp

shp_p, xls = sys.argv[1], sys.argv[2]
F, REC = dbf(shp_p[:-4] + '.dbf'); G = shp(shp_p)
K = [i for i, r in enumerate(REC) if r['ID_CR'] and str(int(r['ID_CR'])).startswith('16790716')]
print('piezas Kalil Hache:', len(K))

wb = openpyxl.load_workbook(xls, read_only=True, data_only=True)
H = {}
for r in wb['Hoja2'].iter_rows(min_row=2, values_only=True):
    if r[0] and str(r[0]).startswith('16790716'): H[str(r[0])] = r

pieces = json.load(open(S('pieces.json'))); att = json.load(open(S('attrs.json'))); lay = json.load(open(S('layers.json')))
pieces = [p for p in pieces if not (p[0] == 6 and str(p[1]) == '716')]
have = {r[0]: i for i, r in enumerate(att['rec'])}
def idx(lst, v):
    if v in (None, ''): return None
    if v not in lst: lst.append(v)
    return lst.index(v)
for i in K:
    idcr = str(int(REC[i]['ID_CR'])); pz = int(idcr[-3:]); h = H.get(idcr)
    fe = h[19] if h else None
    rec = [idcr, '', '', idx(att['var'], h[9] if h else None), idx(att['suelo'], h[13] if h else None),
           idx(att['clase'], h[11] if h else None), fe.strftime('%Y%m%d') if hasattr(fe, 'strftime') else '', 1]
    if idcr in have: att['rec'][have[idcr]] = rec; ri = have[idcr]
    else: att['rec'].append(rec); ri = len(att['rec']) - 1; have[idcr] = ri
    for ring in G[i]:
        pieces.append([6, '716', pz, [[round(x, 5), round(y, 5)] for x, y in ring], ri])

# contorno de la zona (unión aproximada por rasterizado + cierre de 60 m) para la capa de divisiones y la máscara
pts = [p for i in K for ring in G[i] for p in ring]
lon0, lat0 = min(p[0] for p in pts), min(p[1] for p in pts)
mx = 111320 * math.cos(math.radians(lat0)); my = 110574; px = 5.0; pad = 30
W = int((max(p[0] for p in pts) - lon0) * mx / px) + 2 * pad; Hh = int((max(p[1] for p in pts) - lat0) * my / px) + 2 * pad
img = np.zeros((Hh, W), np.uint8)
to = lambda x, y: [int((x - lon0) * mx / px) + pad, Hh - (int((y - lat0) * my / px) + pad)]
for i in K:
    for ring in G[i]: cv2.fillPoly(img, [np.array([to(x, y) for x, y in ring], np.int32)], 255)
k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)); img = cv2.morphologyEx(img, cv2.MORPH_CLOSE, k)
cs, _ = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
back = lambda u, v: [round(lon0 + (u - pad) * px / mx, 6), round(lat0 + (Hh - v - pad) * px / my, 6)]
polys = []
for c in cs:
    if cv2.contourArea(c) < 400: continue
    c = cv2.approxPolyDP(c, 1.5, True)[:, 0, :]; ring = [back(u, v) for u, v in c]; ring.append(ring[0]); polys.append([ring])
print('partes del contorno:', len(polys))
lec = next(d for d in lay['divs'] if d['name'] == 'Lechugas')
lay['kalil'] = polys
lec['polys'] = [p for p in lec['polys'] if not p[0][0] in [q[0][0] for q in polys]] + polys
lay['mask'] = [p for p in lay['mask'] if not p[0][0] in [q[0][0] for q in polys]] + polys
json.dump(pieces, open(S('pieces.json'), 'w'), separators=(',', ':'))
json.dump(att, open(S('attrs.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
json.dump(lay, open(S('layers.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
print('piezas totales', len(pieces), 'rec', len(att['rec']), 'atributos encontrados', sum(1 for i in K if str(int(REC[i]['ID_CR'])) in H))
