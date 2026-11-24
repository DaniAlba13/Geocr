"""Prepara src/suelos.json a partir de la base de suelos (hoja 'AREA REVISADA FINAL V2').
Uso:  python tools/suelos_prep.py RUTA_EXCEL
Una fila por pieza (división, tablón, pieza) con el análisis de suelo; los ceros se toman como sin dato."""
import json, os, sys
import pandas as pd

COLS = [('PH', 'ph'), ('MO%', 'mo'), ('N TOTAL %', 'n'), ('P ppm', 'p'), ('K ppm', 'k'), ('CA ppm', 'ca'),
        ('MG ppm', 'mg'), ('NA ppm', 'na'), ('CIC', 'cic'), ('C.E.µS/cm', 'ce'),
        ('ARENA%', 'arena'), ('LIMO%', 'limo'), ('ARCILLA%', 'arcilla'), ('GRAVAS%', 'gravas')]

def main(ruta):
    x = pd.ExcelFile(ruta)
    hoja = next((s for s in x.sheet_names if 'V2' in s.upper() and 'REVISADA' in s.upper()), None)
    if not hoja:
        sys.exit('No encontré la hoja "AREA REVISADA FINAL V2".')
    df = pd.read_excel(x, hoja)
    df = df.drop_duplicates(['DIVISION_CODE', 'TABLON', 'PIEZA'])
    filas = []
    for _, r in df.iterrows():
        vals = []
        for c, _k in COLS:
            v = r.get(c)
            vals.append(round(float(v), 3) if pd.notna(v) and float(v) > 0 else None)
        if all(v is None for v in vals):
            continue
        anio = int(r['AÑO']) if pd.notna(r.get('AÑO')) and r['AÑO'] > 0 else None
        filas.append([int(r['DIVISION_CODE']), str(int(r['TABLON'])), int(r['PIEZA']), anio] + vals)
    out = dict(campos=[k for _c, k in COLS], filas=filas, fuente=os.path.basename(ruta).split('-', 1)[-1] if len(os.path.basename(ruta).split('-', 1)[0]) == 8 else os.path.basename(ruta), hoja=hoja)
    dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'suelos.json')
    json.dump(out, open(dst, 'w'), separators=(',', ':'))
    print(len(filas), 'piezas con análisis ->', os.path.normpath(dst), os.path.getsize(dst) // 1024, 'KB')

if __name__ == '__main__':
    main(sys.argv[1])
