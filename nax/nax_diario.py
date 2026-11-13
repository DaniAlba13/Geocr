"""
Robot diario de Alertas NAX para GeoCR (corre en GitHub Actions, sin ventanas).

Usa TUS MISMAS funciones de Descarga_Nax_NewEra.py (login, productos, descarga,
maestro de lotes, campaña anterior) y luego reporte.py para el PDF. Lo único que
cambia es que las fechas y la campaña se eligen solas en vez de con la ventana:

  - Si ya hay histórico guardado (caché de GitHub): descarga los últimos DIAS_RECIENTES
    días y los agrega (los duplicados se eliminan igual que en transformacion.py).
  - Si no hay histórico: descarga los últimos VENTANA_DIAS días completos.
  - Siempre recorta el histórico a los últimos VENTANA_DIAS días.

Variables (Settings → Secrets and variables → Actions):
  Secrets:   NAX_EMAIL, NAX_PASSWORD
  Variables: NAX_CAMPANA (opcional; si no, la primera de la lista, como en la ventana),
             VENTANA_DIAS (opcional, 35), DIAS_RECIENTES (opcional, 7)
"""
import os
import sys
import types
from datetime import date, timedelta

AQUI = os.path.dirname(os.path.abspath(__file__))
os.chdir(AQUI)
sys.path.insert(0, AQUI)

# Sin pantalla: se reemplazan los módulos de ventanas por versiones vacías.
_cal = types.ModuleType("tkcalendar")
_cal.DateEntry = object
sys.modules["tkcalendar"] = _cal
try:
    import tkinter  # noqa: F401
except Exception:
    tk = types.ModuleType("tkinter")
    tk.NORMAL, tk.DISABLED = "normal", "disabled"
    for n in ("messagebox", "ttk", "filedialog"):
        setattr(tk, n, types.ModuleType("tkinter." + n))
        sys.modules["tkinter." + n] = getattr(tk, n)
    sys.modules["tkinter"] = tk

import pandas as pd  # noqa: E402
import Descarga_Nax_NewEra as nax  # noqa: E402

ERRORES = []


class _Avisos:
    @staticmethod
    def showerror(titulo, msg):
        ERRORES.append(f"{titulo}: {msg}")
        print(f"✖ {titulo}: {msg}")

    @staticmethod
    def showinfo(titulo, msg):
        print(f"ℹ {titulo}: {msg}")


class _Valor:
    def __init__(self, v):
        self.v = v

    def get(self):
        return self.v


class _Fecha:
    def __init__(self, d):
        self.d = d

    def get_date(self):
        return self.d


class _Boton:
    def config(self, **k):
        pass


nax.messagebox = _Avisos

HIST = os.path.join(AQUI, "historico_actual.csv")
HIST_ANT = nax.RUTA_HISTORICO_CAMPANA_ANTERIOR  # historico_campana_anterior.csv (misma carpeta)
RETENIDO = os.path.join(AQUI, "historico_retenido.csv")  # dato más cercano por pieza e índice, antes del rango
ESTADO = os.path.join(AQUI, "estado_robot.txt")            # campaña con la que se armó el retenido
VENTANA = int(os.environ.get("VENTANA_DIAS") or 35)
DIAS_INICIALES = int(os.environ.get("DIAS_INICIALES") or 180)  # primera vez: llenar el retenido
RECIENTES = int(os.environ.get("DIAS_RECIENTES") or 7)


ES_INDICE = ("ndvi", "biomass", "moisture", "humid", "tsh", "yield_sugarcane", "lai", "ripen")


def actualizar_retenido(desde):
    """Guarda en historico_retenido.csv, por pieza y por cada índice, la lectura más
    reciente ANTERIOR a 'desde' (el inicio del rango del informe). Combina lo que ya
    estaba guardado con el histórico recién descargado, así ninguna pieza que haya
    tenido imagen alguna vez en la zafra se queda sin su dato más cercano."""
    partes = [pd.read_csv(p, low_memory=False) for p in (RETENIDO, HIST) if os.path.exists(p) and os.path.getsize(p)]
    if not partes:
        return
    df = pd.concat(partes, ignore_index=True, sort=False)
    if "timestamp" not in df.columns or "name" not in df.columns:
        return
    t = pd.to_datetime(df["timestamp"], errors="coerce", utc=True).dt.tz_localize(None)
    df = df[t < pd.Timestamp(desde)].copy()
    df["_t"] = t[df.index]
    cols = [c for c in df.columns if any(k in c.lower() for k in ES_INDICE)]
    guardar = set()
    for c in cols:
        v = pd.to_numeric(df[c], errors="coerce")
        sub = df[v.notna()]
        if len(sub):
            guardar.update(sub.sort_values("_t").groupby("name").tail(1).index)
    out = df.loc[sorted(guardar)].drop(columns="_t").drop_duplicates()
    out.to_csv(RETENIDO, index=False)
    print(f"Histórico retenido (dato más cercano antes del {desde}): {len(out)} filas, "
          f"{out['name'].nunique() if len(out) else 0} piezas · índices: {cols}")


def recortar(ruta, desde):
    if not os.path.exists(ruta):
        return
    df = pd.read_csv(ruta)
    if "timestamp" not in df.columns or df.empty:
        return
    t = pd.to_datetime(df["timestamp"], errors="coerce", utc=True).dt.tz_localize(None)
    antes = len(df)
    df = df[t >= pd.Timestamp(desde)]
    df.to_csv(ruta, index=False)
    print(f"Recorte de {os.path.basename(ruta)}: {antes} → {len(df)} filas (desde {desde})")


def main():
    if not nax.email_user or not nax.password_user:
        sys.exit("Faltan los secrets NAX_EMAIL / NAX_PASSWORD en GitHub.")
    nax.headers = nax.login(nax.email_user, nax.password_user)
    if not nax.headers:
        sys.exit("NAX rechazó el inicio de sesión. Revisa NAX_EMAIL y NAX_PASSWORD en los secrets.")
    nax.company_id, nax.areas, nax.tupla_campa = nax.get_user_data(nax.headers)
    if not nax.company_id or not nax.tupla_campa:
        sys.exit("No se pudieron leer las áreas/campañas de la cuenta NAX.")

    nombres = [n for _, n in nax.tupla_campa]
    print("Campañas disponibles:", nombres)
    campana = (os.environ.get("NAX_CAMPANA") or "").strip() or nombres[0]
    if campana not in nombres:
        sys.exit(f"La campaña '{campana}' (variable NAX_CAMPANA) no está en la lista de arriba.")
    print(f"Campaña usada: '{campana}'")

    hoy = date.today()
    previa = open(ESTADO).read().strip() if os.path.exists(ESTADO) else ""
    if previa and previa != campana:
        print(f"Cambió la campaña ('{previa}' → '{campana}'): se empieza el histórico de cero.")
        for p in (HIST, RETENIDO, HIST_ANT):
            if os.path.exists(p):
                os.remove(p)
    with open(ESTADO, "w") as f:
        f.write(campana)
    hay_hist = os.path.exists(HIST) and os.path.getsize(HIST) > 0
    hay_ret = os.path.exists(RETENIDO)
    dias = RECIENTES if (hay_hist and hay_ret) else DIAS_INICIALES
    inicio = hoy - timedelta(days=dias)
    fin = hoy
    txt_ret = "sí" if hay_ret else f"no (primera vez: se llena con {DIAS_INICIALES} días)"
    print(f"Histórico previo: {'sí' if hay_hist else 'no'} · retenido: {txt_ret} · se descargan imágenes del {inicio} al {fin}")

    nax.campaign_combobox = _Valor(campana)
    nax.start_date, nax.end_date = _Fecha(inicio), _Fecha(fin)
    nax.base_var = _Valor("excel")
    nax.save_path = HIST
    nax.report_button = _Boton()

    nax.download_products()
    # Por si no hubo imágenes nuevas (download_products sale antes de bajar el maestro).
    nax.descargar_maestro_lotes(campana, nax.RUTA_MAESTRO_LOTES)
    if not os.path.exists(HIST):
        sys.exit("No hay histórico de la campaña actual: NAX no devolvió imágenes en el rango.")
    actualizar_retenido(hoy - timedelta(days=VENTANA))
    recortar(HIST, hoy - timedelta(days=VENTANA))
    if not os.path.exists(HIST):
        sys.exit("No hay histórico de la campaña actual: NAX no devolvió imágenes en el rango.")

    # Diagnóstico: qué columnas trae NAX y cuántos valores tiene cada una (para revisar los modelos).
    try:
        d = pd.read_csv(HIST, low_memory=False)
        cols = [(c, int(pd.to_numeric(d[c], errors='coerce').notna().sum())) for c in d.columns]
        print("Columnas numéricas del histórico (valores):", ", ".join(f"{c}={n}" for c, n in cols if n))
        for c in d.columns:
            if d[c].dtype == object and d[c].nunique() <= 60:
                print(f"Columna de texto '{c}':", d[c].value_counts().head(15).to_dict())
    except Exception as e:
        print("No se pudo listar columnas:", e)

    # Campaña anterior: mismo período desplazado (lo calcula tu función).
    try:
        nax.download_datos_campana_anterior()
        ant = nax._obtener_campana_anterior(campana, nax.tupla_campa)
        fa, fc = nax._parsear_fecha_campana(ant) if ant else None, nax._parsear_fecha_campana(campana)
        if fa and fc:
            recortar(HIST_ANT, hoy - timedelta(days=VENTANA) + (fa - fc))
    except Exception as e:  # la comparación es opcional, nunca tumba el robot
        print(f"⚠ Campaña anterior no disponible: {e}")

    # PDF con tu reporte.py (mismo resultado que el botón "Generar Reporte PDF").
    try:
        from reporte import generar_reporte_desde_csv
        ruta_pdf, ruta_xlsx = generar_reporte_desde_csv(HIST, os.path.join(AQUI, "reporte_nax.pdf"))
        print("Reporte PDF:", ruta_pdf, "· Excel:", ruta_xlsx)
    except Exception:
        import traceback
        traceback.print_exc()
        print("⚠ No se pudo generar el PDF; el tablero se publica igual.")


if __name__ == "__main__":
    main()
