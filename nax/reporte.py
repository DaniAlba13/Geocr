"""
=====================================================================================
reporte.py - Reporte de Campos con NAX Solutions
=====================================================================================

Este modulo analiza el historico descargado (el mismo CSV que genera
transformacion.agregar_a_historico) y produce un PDF que:
  1) Clasifica cada tablon en categorias de decision (Bien/Cuidado/Cosechar, etc.)
     para 3 metricas: NDVI, indice de maduracion y humedad.
  2) Arma un plan de accion de cosecha/madurante basado en fechas reales. Las
     fechas de inicio y cosecha vienen directamente de NAX (columnas 'start_date'
     y 'harvest_date'); lo unico que NAX no provee es la fecha de aplicacion de
     madurante, que se puede complementar con un archivo opcional.
  3) Senala anomalias hidricas (caidas bruscas o valores atipicos de humedad).

Todos los tablones que aparezcan en 'info_tablones.csv' (si existe) se incluyen en
el reporte, tengan o no imagen satelital en el rango de fechas descargado (los que
no tienen dato aparecen marcados como "Sin dato").

***********************************************************************************
IMPORTANTE: Los rangos en RANGOS son EJEMPLOS (sobre todo los de indice de
maduracion, cuya escala real no conozco). Ajustalos con tu agronomo antes de usar
este reporte para decidir aplicacion de madurantes o cosecha.
***********************************************************************************
"""

import os
import re
import tempfile
from datetime import datetime

import pandas as pd
import matplotlib
matplotlib.use("Agg")  # backend sin interfaz grafica (necesario para correr desde Tkinter)
import matplotlib.pyplot as plt
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as canvas_module
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak, HRFlowable
)


# =====================================================================================
# DATOS DE LA EMPRESA - AJUSTAR AQUI
# =====================================================================================
# Coloca el archivo del logo en la MISMA carpeta que los scripts (junto a
# Descarga_Nax_NewEra.py) y pon aqui el nombre exacto del archivo.
NOMBRE_EMPRESA = "Central Romana Corporation, Ltd."
DEPARTAMENTO = "Departamento de Investigaciones Agrícolas"
AREA = "Área de Agricultura de Precisión"
TITULO_REPORTE = "Reporte de Campos con NAX Solutions"

# Carpeta donde esta este archivo (reporte.py). Usamos esto para que RUTA_LOGO y
# RUTA_INFO_TABLONES SIEMPRE apunten a la carpeta del script, sin importar desde
# donde se ejecute Python (VS Code, terminal, doble clic, etc.) - antes, si la
# carpeta de ejecucion no era exactamente la del script, el logo no se encontraba
# y fallaba en silencio (sin ningun error ni aviso).
_DIRECTORIO_SCRIPT = os.path.dirname(os.path.abspath(__file__))

RUTA_LOGO = os.path.join(_DIRECTORIO_SCRIPT, "CR.png")

# Colores de marca (extraidos del logo). Se usan en encabezados de tabla, la barra
# superior de cada pagina y los titulos. Los colores semaforo (verde/amarillo/
# naranja/rojo) de las categorias en RANGOS mas abajo NO cambian, porque son los
# que indican la accion a tomar por tablon.
COLOR_MARCA_AZUL = "#0053A0"
COLOR_MARCA_ROJO = "#EE3B33"
COLOR_TEXTO = "#231F20"
COLOR_SIN_DATO = "#B0B0B0"


def _dimensiones_logo(ancho_deseado):
    """Calcula el alto proporcional del logo para un ancho dado, leyendo el archivo real."""
    if not os.path.exists(RUTA_LOGO):
        return ancho_deseado, ancho_deseado * 0.3  # valor de respaldo si falta el archivo
    lector = ImageReader(RUTA_LOGO)
    ancho_px, alto_px = lector.getSize()
    return ancho_deseado, ancho_deseado * (alto_px / ancho_px)


# =====================================================================================
# NOMBRES DE COLUMNA DE ORIGEN (tal como los devuelve NAX) vs. NOMBRES INTERNOS
# =====================================================================================
# El resto de este archivo trabaja con los nombres INTERNOS (columna derecha). Si NAX
# cambia el nombre de alguna columna, solo hay que actualizar el lado _ORIGEN aqui abajo.
COLUMNA_TABLON_ORIGEN = "grouping_unit_04"
COLUMNA_PIEZA_ORIGEN = "grouping_unit_05"  # respaldo, solo se usa si no viene 'name'
COLUMNA_NAME_ORIGEN = "name"  # ID unico de PIEZA: administracion+division+distrito+tablon+pieza
COLUMNA_DIVISION_ORIGEN = "grouping_unit_02"
COLUMNA_VARIEDAD_ORIGEN = "variety"
COLUMNA_FECHA_INICIO_ORIGEN = "start_date"
COLUMNA_FECHA_COSECHA_ORIGEN = "harvest_date"
COLUMNA_IRRIGATION_ORIGEN = "irrigation"
COLUMNA_ACRES_ORIGEN = "effective_area"  # ya viene en acres, no hace falta convertir
COLUMNA_TCH_INGENIO_ESTIMADO_ORIGEN = "estimated_crop_yield"  # Estimado DEL INGENIO (su propia
                                  # proyeccion agronomica del campo, NO es un modelo satelital de
                                  # NAX, aunque el nombre que usa NAX para este campo confunda -
                                  # confirmado por el usuario con datos reales de la campaña 2026).
COLUMNA_TCH_REAL_ORIGEN = "crop_yield"  # TCH real, lo llena el ingenio al cerrar/cosechar el campo

COLUMNA_TABLON = "tablon_id"
COLUMNA_PIEZA = "pieza_id"
COLUMNA_ID_UNICO = "id_pieza_unico"  # clave real de analisis: una fila = una PIEZA
COLUMNA_DIVISION = "division"
COLUMNA_VARIEDAD = "variedad"
COLUMNA_FECHA_INICIO = "fecha_inicio"
COLUMNA_FECHA_COSECHA = "fecha_cosecha"
COLUMNA_ACRES = "acres"
COLUMNA_TCA_ESTIMADO = "tca_estimado"  # ESTIMADO POR NAX (modelo satelital - ver mas abajo donde se
                                        # arma, columna 'tsh' pivotada del producto 'yield_sugarcane')
COLUMNA_TCA_REAL = "tca_real"
COLUMNA_TCA_INGENIO_ESTIMADO = "tca_ingenio_estimado"  # Estimado DEL INGENIO (no satelital)
COLUMNA_ES_REGADO = "es_regado"  # 0/1, calculado del campo crudo 'irrigation' -
                                  # aplica a TODA la operacion (no solo Higueral/Baigua)

# Nombre interno (y clave de RANGOS) para el modelo de Humedad - se mantiene el
# nombre historico 'moisture_percentage_optical_and_sar' aunque el producto que de
# verdad llega en la descarga pueda tener otro nombre (ver _normalizar_columnas,
# donde se normaliza 'moisture_distribution_high_frequency' a esta misma columna).
COLUMNA_HUMEDAD = "moisture_percentage_optical_and_sar"

# TCH (toneladas de caña por hectárea) / 2.47 = TCA (toneladas de caña por acre),
# porque 1 hectárea = 2.47 acres.
FACTOR_HECTAREA_A_ACRE = 2.47


def _limpiar_valor_name(valor):
    """Convierte un valor de 'name' (puede venir como int64, float64 con .0, o texto)
    a un texto canonico: sin decimales y, si es numerico, rellenado a 11 digitos. Asi
    la misma pieza coincide venga del historico (numero, pierde ceros a la izquierda)
    o del maestro de lotes (texto)."""
    if pd.isna(valor):
        return None
    if isinstance(valor, float):
        valor = int(valor)
    texto = str(valor).strip()
    if texto.endswith(".0"):
        texto = texto[:-2]
    if texto.isdigit() and len(texto) <= 11:
        texto = texto.zfill(11)
    return texto


def _decodificar_name_uno(valor):
    """Decodifica UN valor de 'name' en (administracion, division, distrito, tablon,
    pieza), segun el formato de NAX: administracion(1) + division(1) + distrito(2) +
    tablon(4) + pieza(3) = 11 digitos de ancho fijo. Los ceros a la izquierda a veces
    se pierden al guardarse el numero (ej. administracion=0 hace que el numero se vea
    de 10 digitos en vez de 11), por eso siempre se rellena a 11 antes de leer las
    posiciones. Devuelve (None, None, None, None, None) si no se puede decodificar
    con confianza (valor vacio o con mas de 11 digitos)."""
    texto = _limpiar_valor_name(valor)
    if texto is None:
        return (None, None, None, None, None)
    texto = texto.zfill(11)
    if len(texto) > 11:
        return (None, None, None, None, None)
    administracion = texto[0:1]
    division = texto[1:2]
    distrito = texto[2:4]
    tablon = texto[4:8]
    pieza = texto[8:11]
    return (administracion, division, distrito, tablon, pieza)


def _decodificar_name(serie_name):
    """Version vectorizada de _decodificar_name_uno para una columna completa.
    Devuelve un DataFrame con columnas administracion_id, distrito_id,
    tablon_desde_name, pieza_desde_name (division_desde_name no se usa por ahora -
    la division ya viene confirmada de grouping_unit_02)."""
    decodificado = serie_name.apply(_decodificar_name_uno)
    return pd.DataFrame(
        decodificado.tolist(), index=serie_name.index,
        columns=["administracion_id", "division_desde_name", "distrito_id",
                 "tablon_desde_name", "pieza_desde_name"]
    )

# 'grouping_unit_02' trae el NUMERO de la division, no el nombre. Este mapeo lo
# convierte al nombre real. Si agregan/renumeran divisiones, ajustar aqui.
MAPEO_DIVISIONES = {
    "1": "Higueral",
    "2": "Guaymate",
    "3": "La Higuera",
    "4": "Chavón Abajo",
    "5": "Cuyá",
    "6": "Lechugas",
    "7": "Baigua",
}

# Divisiones que SI pueden tener riego. Para estas dos, cada tablon se separa en
# "<Division> (R)" (con riego, irrigation=1) o "<Division> (S)" (sin riego,
# irrigation=0). Cualquier OTRA division con irrigation=1 se considera un error de
# datos: no se le aplica el sufijo, y se cuenta aparte (ver _contar_anomalias_riego).
DIVISIONES_CON_RIEGO = ["Higueral", "Baigua"]

# Orden en el que deben aparecer las divisiones en las tablas (1 a 7, tal como las
# numeran en NAX), no alfabetico. Se calcula solo (sigue el orden del diccionario
# de arriba) - no hay que tocar esto si cambia MAPEO_DIVISIONES.
ORDEN_DIVISIONES = list(MAPEO_DIVISIONES.values())


def _clave_orden_division(valor):
    """Clave de orden para una division, incluyendo las variantes '(R)'/'(S)'. Las
    divisiones reconocidas (1-7) van primero en su orden numerico (sin riego antes
    que con riego, igual que en el reporte de referencia); cualquier otra queda al
    final, alfabetica."""
    base = valor
    rango_sufijo = 0
    for sufijo, rango in ((" (S)", 0), (" (R)", 1)):
        if valor.endswith(sufijo):
            base = valor[: -len(sufijo)]
            rango_sufijo = rango
            break
    if base in ORDEN_DIVISIONES:
        return (0, ORDEN_DIVISIONES.index(base), rango_sufijo, valor)
    return (1, 0, 0, valor)


def _categorias_division(valores_presentes):
    """Lista de categorias para ordenar una tabla por division: 1-7 (con las
    variantes (R)/(S) de Higueral y Baigua en su lugar), no alfabetico."""
    return sorted(set(valores_presentes), key=_clave_orden_division)


def _con_division_ordenada(df):
    """Devuelve una copia de df con la columna de division convertida a categorica
    ordenada (1 a 7), para que cualquier sort_values/groupby respete ese orden."""
    df = df.copy()
    categorias = _categorias_division(df[COLUMNA_DIVISION].unique())
    df[COLUMNA_DIVISION] = pd.Categorical(df[COLUMNA_DIVISION], categories=categorias, ordered=True)
    return df


def _normalizar_clave_division(valor):
    """Convierte el valor crudo de division a una clave de texto simple para buscar
    en MAPEO_DIVISIONES. NAX lo manda de mas de una forma segun la descarga: numero
    puro (1, 1.0, '1') en algunas, o 'codigo-NOMBRE' (ej. '01-HIGUERAL', visto en la
    descarga real de la campaña 2026) en otras - en ambos casos la clave real es el
    NUMERO inicial, sin ceros a la izquierda, asi que se extrae con una regex en vez
    de asumir que el valor es solo un numero."""
    if pd.isna(valor):
        return None
    texto = str(valor).strip()
    if texto.endswith(".0"):
        texto = texto[:-2]
    coincidencia = re.match(r"0*(\d+)", texto)
    if coincidencia:
        return coincidencia.group(1)
    return texto


def _limpiar_id_tablon(valor):
    """Quita el '.0' que a veces deja pandas al leer una columna numerica con NaN
    (ej. '30.0' -> '30'). El identificador de tablon queda tal cual viene de
    grouping_unit_04 en cualquier otro caso (el codigo nunca le agrega prefijos)."""
    texto = str(valor).strip()
    if texto.endswith(".0"):
        texto = texto[:-2]
    return texto


def _valor_riego_a_binario(valor):
    """Interpreta el valor crudo de 'irrigation' como 1 (con riego) o 0 (sin riego),
    aceptando las formas mas comunes en que puede venir el dato (numero, texto,
    booleano) en vez de asumir que siempre es exactamente 1/0 numerico."""
    if pd.isna(valor):
        return 0
    texto = str(valor).strip().upper()
    if texto in {"1", "1.0", "TRUE", "SI", "SÍ", "S", "YES", "Y", "R", "REGADIO", "REGADÍO"}:
        return 1
    try:
        return 1 if float(texto) == 1 else 0
    except ValueError:
        return 0


def _aplicar_riego(df):
    """Separa Higueral y Baigua en '(R)'/'(S)' segun la columna 'irrigation'. A
    cualquier otra division NO se le toca el nombre, aunque su irrigation venga en 1
    (eso es un error de datos, contado aparte por _contar_anomalias_riego). De paso,
    agrega COLUMNA_ES_REGADO (0/1) para TODA la operacion, sin importar la division -
    se usa en el analisis de TCA por riego vs secano."""
    # Las demas divisiones (1-7) son todas de secano: se marcan siempre con (S).
    df = df.copy()
    secano = df[COLUMNA_DIVISION].isin([d for d in ORDEN_DIVISIONES if d not in DIVISIONES_CON_RIEGO])
    df.loc[secano, COLUMNA_DIVISION] = df.loc[secano, COLUMNA_DIVISION] + " (S)"
    if COLUMNA_IRRIGATION_ORIGEN not in df.columns:
        df[COLUMNA_ES_REGADO] = None
        return df
    riego = df[COLUMNA_IRRIGATION_ORIGEN].apply(_valor_riego_a_binario)
    df[COLUMNA_ES_REGADO] = riego
    aplica = df[COLUMNA_DIVISION].isin(DIVISIONES_CON_RIEGO)
    sufijo = riego.map({1: " (R)"}).fillna(" (S)")
    df.loc[aplica, COLUMNA_DIVISION] = df.loc[aplica, COLUMNA_DIVISION] + sufijo.loc[aplica]
    return df


def _contar_anomalias_riego(df_historico):
    """Cuenta cuantos TABLONES (no filas) fuera de Higueral/Baigua tienen irrigation=1
    en los datos crudos - indica un posible error de datos."""
    if COLUMNA_IRRIGATION_ORIGEN not in df_historico.columns or \
       COLUMNA_DIVISION_ORIGEN not in df_historico.columns or \
       COLUMNA_TABLON_ORIGEN not in df_historico.columns:
        return 0
    claves = df_historico[COLUMNA_DIVISION_ORIGEN].apply(_normalizar_clave_division)
    respaldo_texto = df_historico[COLUMNA_DIVISION_ORIGEN].apply(lambda v: str(v) if pd.notna(v) else "")
    division_base = claves.map(MAPEO_DIVISIONES).fillna(respaldo_texto)
    riego = pd.to_numeric(df_historico[COLUMNA_IRRIGATION_ORIGEN], errors="coerce").fillna(0)
    fuera_de_riego = ~division_base.isin(DIVISIONES_CON_RIEGO)
    tablones_anomalos = df_historico.loc[(riego == 1) & fuera_de_riego, COLUMNA_TABLON_ORIGEN]
    return int(tablones_anomalos.nunique())


def _normalizar_columnas(df):
    """Renombra las columnas de origen de NAX a los nombres internos que usa el resto
    del modulo, y rellena valores por defecto cuando falta alguna columna opcional."""
    df = df.copy()
    mapa = {
        COLUMNA_TABLON_ORIGEN: COLUMNA_TABLON,
        COLUMNA_PIEZA_ORIGEN: COLUMNA_PIEZA,
        COLUMNA_DIVISION_ORIGEN: COLUMNA_DIVISION,
        COLUMNA_FECHA_INICIO_ORIGEN: COLUMNA_FECHA_INICIO,
        COLUMNA_FECHA_COSECHA_ORIGEN: COLUMNA_FECHA_COSECHA,
        COLUMNA_ACRES_ORIGEN: COLUMNA_ACRES,
        COLUMNA_TCH_INGENIO_ESTIMADO_ORIGEN: "tch_ingenio_estimado_tmp",
        COLUMNA_TCH_REAL_ORIGEN: "tch_real_tmp",
    }
    mapa = {origen: interno for origen, interno in mapa.items() if origen in df.columns}
    df = df.rename(columns=mapa)

    # Humedad: el nombre de columna que resulta del pivot no siempre coincide con
    # COLUMNA_HUMEDAD ('moisture_percentage_optical_and_sar', el que se confirmo en
    # su momento con datos reales) - el producto pedido en Descarga_Nax_NewEra.py
    # cambio mas de una vez (de 'sugarcane_humidity_level2', que no existe en el
    # Anexo III, al correcto 'sugarcane_humidity'; tambien existe la variante
    # 'sugarcane_humidity_noclouds'), y no hay garantia de que el pivot siempre
    # devuelva la misma columna. En vez de asumir un solo nombre fijo, se buscan
    # TODAS las columnas candidatas (que mencionen humedad/humidity/moisture) y se
    # usa la que tenga MAS datos numericos validos - mismo criterio que ya se usa
    # para TCA estimado con las columnas candidatas a 'tsh'.
    if COLUMNA_HUMEDAD not in df.columns:
        columnas_humedad = [c for c in df.columns
                            if c != COLUMNA_HUMEDAD
                            and ("humid" in c.lower() or "moisture" in c.lower())]
        if columnas_humedad:
            conteo_validos = {c: pd.to_numeric(df[c], errors="coerce").notna().sum() for c in columnas_humedad}
            mejor_columna = max(conteo_validos, key=conteo_validos.get)
            if len(columnas_humedad) > 1:
                print(f"Varias columnas candidatas para Humedad {columnas_humedad} - se usa "
                      f"'{mejor_columna}' ({conteo_validos[mejor_columna]} valores numéricos válidos).")
            df = df.rename(columns={mejor_columna: COLUMNA_HUMEDAD})

    # Mismo criterio para NDVI y Biomasa: NAX no siempre deja el indice con el mismo
    # nombre (ej. 'biomass_optical' vacio y 'biomass_optical_and_sar' con datos). Se
    # usa la columna candidata con MAS valores numericos, para no perder el indice.
    for clave_indice, texto_indice in (("ndvi_optical", "ndvi"), ("biomass_optical", "biomass")):
        candidatas = [c for c in df.columns if texto_indice in c.lower()]
        if not candidatas:
            continue
        conteo_validos = {c: pd.to_numeric(df[c], errors="coerce").notna().sum() for c in candidatas}
        mejor_columna = max(conteo_validos, key=conteo_validos.get)
        if mejor_columna != clave_indice and conteo_validos[mejor_columna] > conteo_validos.get(clave_indice, 0):
            print(f"Para '{clave_indice}' se usa '{mejor_columna}' ({conteo_validos[mejor_columna]} valores numéricos válidos).")
            if clave_indice in df.columns:
                df = df.drop(columns=[clave_indice])
            df = df.rename(columns={mejor_columna: clave_indice})

    tiene_grouping_unit_04 = COLUMNA_TABLON in df.columns  # ya renombrado arriba si existia
    tiene_name = COLUMNA_NAME_ORIGEN in df.columns

    if not tiene_grouping_unit_04 and not tiene_name:
        raise ValueError(
            f"No se encontró ni '{COLUMNA_TABLON_ORIGEN}' ni '{COLUMNA_NAME_ORIGEN}' "
            "(identificadores de tablón/pieza) en los datos descargados. Revisa las "
            "columnas del CSV que devuelve NAX."
        )

    if tiene_grouping_unit_04:
        df[COLUMNA_TABLON] = df[COLUMNA_TABLON].apply(_limpiar_id_tablon)

    if COLUMNA_PIEZA in df.columns:
        df[COLUMNA_PIEZA] = df[COLUMNA_PIEZA].apply(_limpiar_id_tablon)
    else:
        df[COLUMNA_PIEZA] = "N/D"

    # 'name' es el identificador REAL de PIEZA (mas fino que grouping_unit_04/05):
    # administracion+division+distrito+tablon+pieza, todo en un solo numero. Si esta
    # disponible, se decodifica y se usa para tablon/pieza (mas confiable), y ademas
    # se usa el propio 'name' como clave unica de analisis (una fila = una pieza). Si
    # no esta disponible, se cae de vuelta al comportamiento anterior (grouping_unit_04
    # como clave, es decir, analisis a nivel de tablon).
    if tiene_name:
        decodificado = _decodificar_name(df[COLUMNA_NAME_ORIGEN])
        if tiene_grouping_unit_04:
            df[COLUMNA_TABLON] = decodificado["tablon_desde_name"].where(
                decodificado["tablon_desde_name"].notna(), df[COLUMNA_TABLON])
            df[COLUMNA_PIEZA] = decodificado["pieza_desde_name"].where(
                decodificado["pieza_desde_name"].notna(), df[COLUMNA_PIEZA])
        else:
            df[COLUMNA_TABLON] = decodificado["tablon_desde_name"]
            df[COLUMNA_PIEZA] = decodificado["pieza_desde_name"]
        df[COLUMNA_ID_UNICO] = df[COLUMNA_NAME_ORIGEN].apply(_limpiar_valor_name)
        # Si algun 'name' no se pudo leer (vacio), usar el tablon como respaldo para
        # no perder la fila.
        df[COLUMNA_ID_UNICO] = df[COLUMNA_ID_UNICO].fillna(df[COLUMNA_TABLON])
    else:
        df[COLUMNA_ID_UNICO] = df[COLUMNA_TABLON]

    if COLUMNA_ACRES in df.columns:
        df[COLUMNA_ACRES] = pd.to_numeric(df[COLUMNA_ACRES], errors="coerce")
    else:
        df[COLUMNA_ACRES] = float("nan")

    if COLUMNA_VARIEDAD_ORIGEN in df.columns:
        df[COLUMNA_VARIEDAD] = df[COLUMNA_VARIEDAD_ORIGEN].fillna("N/D")
    else:
        df[COLUMNA_VARIEDAD] = "N/D"

    # TCH (toneladas/hectarea) -> TCA (toneladas/acre), dividiendo entre 2.47.
    #
    # TCA ESTIMADO POR NAX: siempre sale del producto satelital descargado
    # 'yield_sugarcane' (agregado a productos_confirmados en Descarga_Nax_NewEra.py).
    # El nombre de columna que deja el pivot de transformacion.py para este producto
    # NO siempre es el mismo: se ha visto como 'tsh' en algunos historicos reales, y
    # es posible que otras descargas lo dejen con el nombre literal 'yield_sugarcane'
    # (o variantes con sufijo '_x'/'_y' por un cruce viejo de pandas) - en vez de
    # asumir un solo nombre fijo, se buscan TODAS las columnas candidatas y se usa la
    # que tenga MAS datos numericos validos. OJO: 'estimated_crop_yield' NO es este
    # estimado satelital, es el estimado propio DEL INGENIO (ver
    # tch_ingenio_estimado_tmp -> COLUMNA_TCA_INGENIO_ESTIMADO mas abajo) - ya se
    # renombro a 'tch_ingenio_estimado_tmp' unas lineas arriba, asi que buscar aqui
    # por 'yield' ya no choca con ese campo.
    columnas_tsh = [c for c in df.columns if "tsh" in c.lower() or "yield_sugarcane" in c.lower()]
    if columnas_tsh:
        conteo_validos = {c: pd.to_numeric(df[c], errors="coerce").notna().sum() for c in columnas_tsh}
        mejor_columna = max(conteo_validos, key=conteo_validos.get)
        if len(columnas_tsh) > 1:
            print(f"Varias columnas candidatas para TCA estimado NAX {columnas_tsh} - se usa "
                  f"'{mejor_columna}' ({conteo_validos[mejor_columna]} valores numéricos válidos).")
        df[COLUMNA_TCA_ESTIMADO] = pd.to_numeric(df[mejor_columna], errors="coerce") / FACTOR_HECTAREA_A_ACRE
    else:
        df[COLUMNA_TCA_ESTIMADO] = float("nan")

    # TCA ESTIMADO POR EL INGENIO (su propia proyeccion agronomica del campo, no
    # satelital) - sale de 'estimated_crop_yield'.
    if "tch_ingenio_estimado_tmp" in df.columns:
        df[COLUMNA_TCA_INGENIO_ESTIMADO] = (
            pd.to_numeric(df["tch_ingenio_estimado_tmp"], errors="coerce") / FACTOR_HECTAREA_A_ACRE)
    else:
        df[COLUMNA_TCA_INGENIO_ESTIMADO] = float("nan")

    if "tch_real_tmp" in df.columns:
        df[COLUMNA_TCA_REAL] = pd.to_numeric(df["tch_real_tmp"], errors="coerce") / FACTOR_HECTAREA_A_ACRE
    else:
        df[COLUMNA_TCA_REAL] = float("nan")

    if COLUMNA_DIVISION not in df.columns:
        df[COLUMNA_DIVISION] = "Todos los tablones"
    else:
        claves = df[COLUMNA_DIVISION].apply(_normalizar_clave_division)
        nombres = claves.map(MAPEO_DIVISIONES)
        # Si el numero no esta en el mapeo (division nueva/no prevista), se deja el
        # valor original en vez de romper o mostrar vacio. OJO: .astype(str) de una
        # columna con NaN real NO siempre da el texto "nan" (depende del dtype) - se
        # arma el respaldo a mano para garantizar SIEMPRE un texto, nunca un NaN/float.
        respaldo_texto = df[COLUMNA_DIVISION].apply(
            lambda v: str(v) if pd.notna(v) else "Todos los tablones")
        df[COLUMNA_DIVISION] = nombres.fillna(respaldo_texto)

    df = _aplicar_riego(df)

    for col_fecha in (COLUMNA_FECHA_INICIO, COLUMNA_FECHA_COSECHA):
        if col_fecha in df.columns:
            df[col_fecha] = pd.to_datetime(df[col_fecha], errors="coerce")
        else:
            df[col_fecha] = pd.NaT

    df["timestamp"] = pd.to_datetime(df["timestamp"])
    return df


# =====================================================================================
# CONFIGURACION DE RANGOS - AJUSTAR SEGUN CRITERIO AGRONOMICO
# =====================================================================================
# Cada metrica tiene una lista de "tiers" (categorias) ordenados de MAYOR a MENOR valor.
# Cada tier es (valor_minimo, etiqueta, color_hex). Un tablon cae en el PRIMER tier cuyo
# valor_minimo sea <= al valor. El ultimo tier de cada lista debe tener valor_minimo =
# float("-inf") para cubrir cualquier valor por debajo de los demas. Los tablones sin
# lectura (NaN) se clasifican aparte como "Sin dato", no hace falta incluir eso aqui.
#
# Los nombres de columna (las llaves del diccionario) deben coincidir exactamente con
# los nombres de producto que pides en 'productos_list' en Descarga_Nax_NewEra.py.

RANGOS = {
    COLUMNA_HUMEDAD: {
        "nombre": "Humedad",
        "descripcion": (
            "Este modelo estima el contenido de humedad del suelo a partir de sensores ópticos "
            "y de radar, permitiendo identificar de forma temprana los campos con déficit hídrico "
            "que podrían requerir riego o atención agronómica."
        ),
        "tiers": [
            (72.0,            "Bien",                          "#2E7D32"),
            (70.0,            "Revisar",                       "#EF6C00"),
            (float("-inf"),   "Alerta por deficit de humedad", "#C62828"),
        ],
    },
    "ndvi_optical": {
        "nombre": "NDVI (vigor vegetal)",
        "descripcion": (
            "El NDVI mide el vigor vegetativo del cultivo a partir de imágenes satelitales, "
            "permitiendo identificar zonas con crecimiento saludable frente a otras con posibles "
            "deficiencias nutricionales, hídricas o de manejo."
        ),
        # Umbrales agronomicos confirmados (ya no son un ejemplo generico):
        # optimo >= 0.57, normal 0.53-0.57, bajo 0.50-0.53, critico < 0.50.
        "tiers": [
            (0.57,            "Vigor alto",     "#2E7D32"),
            (0.53,            "Vigor normal",   "#9E9D24"),
            (0.50,            "Vigor bajo",     "#EF6C00"),
            (float("-inf"),   "Vigor critico",  "#C62828"),
        ],
    },
    "biomass_optical": {
        # OJO: no conozco la escala real de este producto (en el dashboard de NAX se
        # vio en un rango aprox. 0-2.5, "Area foliar"). Estos valores son un
        # marcador de posicion - ajustalos en cuanto veas datos reales.
        "nombre": "Biomasa (Área Foliar)",
        "descripcion": (
            "Este modelo estima la biomasa foliar del cultivo, un indicador del desarrollo y la "
            "densidad de la cobertura vegetal, útil para monitorear el crecimiento a lo largo del "
            "ciclo y detectar variaciones respecto al comportamiento esperado."
        ),
        "tiers": [
            (1.5,             "Biomasa alta",     "#2E7D32"),
            (1.0,             "Biomasa normal",   "#9E9D24"),
            (0.5,             "Biomasa baja",     "#EF6C00"),
            (float("-inf"),   "Biomasa critica",  "#C62828"),
        ],
    },
}


# Metricas cuya lista "destacada" debe ser la MEJOR categoria en vez de la peor (por
# ahora ninguna - se usaba para maduracion, que se quitó del reporte). Se deja el
# mecanismo por si algún modelo futuro lo necesita.
METRICAS_DESTACAR_MEJOR = []


def _categoria_critica(metrica):
    """La categoria que se destaca en la lista de atencion de un modelo: la peor
    (ultimo tier) para la mayoria de los modelos, o la mejor (primer tier) para los
    que estan en METRICAS_DESTACAR_MEJOR."""
    tiers = RANGOS[metrica]["tiers"]
    if metrica in METRICAS_DESTACAR_MEJOR:
        return tiers[0][1]
    return tiers[-1][1]


# =====================================================================================
# INFORMACION COMPLEMENTARIA POR TABLON (solo lo que NAX NO provee)
# =====================================================================================
# 'info_tablones.csv' (en la misma carpeta) es OPCIONAL. NAX ya entrega, por tablon,
# 'start_date' y 'harvest_date' dentro del propio historico, asi que normalmente no
# hace falta este archivo para eso. Sirve para dos casos:
#   1) Tablones que no generaron NINGUNA imagen en el rango descargado (no apareceran
#      en el historico en absoluto) - si los agregas aqui, igual salen en el reporte
#      marcados como "Sin dato".
#   2) La fecha de aplicacion de madurante, que NAX no maneja.
#
# Columnas esperadas: tablon_id, division, start_date, harvest_date,
# fecha_ultima_aplicacion_madurante
# (division/start_date/harvest_date son opcionales: solo se usan si el tablon no
# aparece para nada en el historico descargado)

RUTA_INFO_TABLONES = os.path.join(_DIRECTORIO_SCRIPT, "info_tablones.csv")
VENTANA_MADURANTE_DIAS = 40  # dias entre aplicacion de madurante y corte
DIAS_POR_MES = 30.44


def _cargar_info_tablones():
    """Lee info_tablones.csv si existe. Devuelve None si no esta disponible."""
    if not os.path.exists(RUTA_INFO_TABLONES):
        return None
    info = pd.read_csv(RUTA_INFO_TABLONES, dtype={"tablon_id": str})
    for col in ("start_date", "harvest_date", "fecha_ultima_aplicacion_madurante"):
        if col in info.columns:
            info[col] = pd.to_datetime(info[col], errors="coerce")
        else:
            info[col] = pd.NaT
    if "division" not in info.columns:
        info["division"] = "Todos los tablones"
    return info.set_index("tablon_id")


def _clasificar(valor, tiers):
    """Devuelve (etiqueta, color) del primer tier cuyo umbral el valor alcanza.
    Si el valor es NaN (sin lectura), devuelve la categoria 'Sin dato'."""
    if pd.isna(valor):
        return "Sin dato", COLOR_SIN_DATO
    for umbral_min, etiqueta, color in tiers:
        if valor >= umbral_min:
            return etiqueta, color
    return None, None


def _columnas_disponibles(df):
    return [m for m in RANGOS if m in df.columns]


# =====================================================================================
# COBERTURA TOTAL: MAESTRO DE LOTES + PROYECCION DE CAMPOS SIN LECTURA
# =====================================================================================
# El historico solo contiene los campos que tuvieron imagen satelital en alguna
# descarga. El "maestro de lotes" (descargado por Descarga_Nax_NewEra.py desde
# /api/v1/campaigns/{id}/lots) trae TODOS los campos de la campaña, con su area,
# fecha de inicio, riego, variedad y TCH estimado. Con eso:
#   1) Se agregan al reporte los campos que nunca tuvieron imagen.
#   2) A cada campo sin lectura de un modelo se le asigna un valor PROYECTADO: primero
#      su propio ultimo valor historico (si alguna vez tuvo lectura); si nunca la tuvo,
#      la mediana de campos similares (misma division, mismo riego y edad parecida,
#      relajando esos criterios si no hay suficientes campos similares).
# Cada valor queda marcado con su origen ("Satelital" o "Proyectado"), para que el
# reporte y el Excel siempre distingan lo medido de lo proyectado.
RUTA_MAESTRO_LOTES = os.path.join(_DIRECTORIO_SCRIPT, "maestro_lotes.csv")
RUTA_MAESTRO_LOTES_ANTERIOR = os.path.join(_DIRECTORIO_SCRIPT, "maestro_lotes_campana_anterior.csv")
RUTA_HISTORICO_RETENIDO = os.path.join(_DIRECTORIO_SCRIPT, "historico_retenido.csv")
ORIGEN_OBSERVADO = "Satelital"
ORIGEN_PROYECTADO = "Proyectado"


def _cargar_maestro(ruta):
    """Lee y normaliza un maestro de lotes. Devuelve None si no existe o no se puede usar."""
    if not os.path.exists(ruta):
        return None
    maestro = pd.read_csv(ruta)
    if maestro.empty:
        return None
    if "timestamp" not in maestro.columns:
        maestro["timestamp"] = pd.NaT
    try:
        maestro = _normalizar_columnas(maestro)
    except ValueError as e:
        print(f"⚠ No se pudo usar el maestro de lotes '{os.path.basename(ruta)}': {e}")
        return None
    if COLUMNA_NAME_ORIGEN not in maestro.columns:
        print(f"⚠ El maestro '{os.path.basename(ruta)}' no trae la columna 'name' - los campos se "
              "identifican por tablón y pueden no coincidir pieza a pieza con el histórico.")
    return maestro.drop_duplicates(subset=[COLUMNA_ID_UNICO])


def _es_vacio(serie):
    """True donde el valor falta o es un marcador de 'sin dato' de texto."""
    return serie.isna() | serie.astype(str).isin(["N/D", "Todos los tablones", "None", "nan", ""])


def _completar_con_maestro(df_ultima, maestro, metricas):
    """Completa atributos faltantes de las piezas ya presentes con los del maestro, y
    agrega como filas nuevas las piezas del maestro que nunca aparecieron en el
    historico (sin valores de modelos - esos se proyectan despues)."""
    atributos = [COLUMNA_TABLON, COLUMNA_PIEZA, COLUMNA_DIVISION, COLUMNA_VARIEDAD, COLUMNA_ACRES,
                 COLUMNA_FECHA_INICIO, COLUMNA_FECHA_COSECHA, COLUMNA_ES_REGADO,
                 COLUMNA_TCA_ESTIMADO, COLUMNA_TCA_REAL, COLUMNA_TCA_INGENIO_ESTIMADO]
    m = maestro.set_index(COLUMNA_ID_UNICO)
    df_ultima = df_ultima.copy()
    for col in atributos:
        if col not in m.columns:
            continue
        if col not in df_ultima.columns:
            df_ultima[col] = None
        del_maestro = df_ultima[COLUMNA_ID_UNICO].map(m[col])
        # Solo reemplazar cuando el valor actual esta vacio Y el maestro SI tiene algo
        # que ofrecer - si la pieza tampoco esta en el maestro (del_maestro = NaN), se
        # deja el valor original (aunque sea el generico "Todos los tablones") en vez
        # de dejarlo en NaN/float, que rompe cualquier texto que luego una esa columna.
        reemplazar = _es_vacio(df_ultima[col]) & del_maestro.notna()
        df_ultima[col] = df_ultima[col].where(~reemplazar, del_maestro)

    faltantes = m.index.difference(pd.Index(df_ultima[COLUMNA_ID_UNICO].dropna()))
    if len(faltantes):
        nuevas = m.loc[faltantes, [c for c in atributos if c in m.columns]].reset_index()
        nuevas["timestamp"] = pd.NaT
        for metrica in metricas:
            nuevas[metrica] = float("nan")
        df_ultima = pd.concat([df_ultima, nuevas], ignore_index=True)
    return df_ultima


def _proyectar_faltantes(df, columna, etiqueta_observado=ORIGEN_OBSERVADO, valor_minimo=None):
    """Rellena los valores faltantes de 'columna' con la mediana de campos similares y
    agrega la columna '<columna>_origen'. Si se indica valor_minimo, los valores por
    debajo se tratan como ruido (faltantes) y tambien se proyectan. Niveles de
    similitud, del mas al menos especifico: division+riego+edad (mes), division+riego,
    division, y por ultimo toda la operacion."""
    df = df.copy()
    valores = pd.to_numeric(df[columna], errors="coerce")
    if valor_minimo is not None:
        valores = valores.where(valores >= valor_minimo)
    observados = valores.notna()
    origen = pd.Series(ORIGEN_PROYECTADO, index=df.index, dtype=object)
    origen[observados] = etiqueta_observado

    if not observados.any():
        df[columna] = float("nan")
        df[f"{columna}_origen"] = "Sin dato"
        return df

    hoy = pd.Timestamp.now().normalize()
    fecha_inicio = pd.to_datetime(df.get(COLUMNA_FECHA_INICIO), errors="coerce")
    edad_meses = ((hoy - fecha_inicio).dt.days / DIAS_POR_MES).round()
    # OJO: .astype(str) de una serie con NaN real no siempre da el texto "nan" (ya nos
    # paso con 'division') - aqui es aun mas facil que pase, porque "sin fecha de
    # inicio" (piezas nuevas del maestro) es comun. Se arma el texto a mano para
    # garantizar que estas 3 columnas sean SIEMPRE texto antes del "|".join() de mas
    # abajo, sin importar que tan vacios vengan division/riego/fecha_inicio.
    def _col_segura(serie):
        return serie.apply(lambda v: str(v) if pd.notna(v) else "")

    aux = pd.DataFrame({
        "division": _col_segura(df.get(COLUMNA_DIVISION, pd.Series("", index=df.index))),
        "riego": _col_segura(df.get(COLUMNA_ES_REGADO, pd.Series("", index=df.index))),
        "edad": _col_segura(edad_meses),
        "valor": valores,
    }, index=df.index)

    for claves in (["division", "riego", "edad"], ["division", "riego"], ["division"]):
        faltan = aux["valor"].isna()
        if not faltan.any():
            break
        llave = aux[claves].agg("|".join, axis=1)
        medianas = aux.loc[observados, "valor"].groupby(llave[observados]).median()
        aux.loc[faltan, "valor"] = llave[faltan].map(medianas)
    aux["valor"] = aux["valor"].fillna(aux.loc[observados, "valor"].median())

    df[columna] = aux["valor"]
    df[f"{columna}_origen"] = origen
    return df


def clasificar_datos(df):
    """
    Toma la ultima lectura satelital de cada PIEZA (no de cada tablon - un tablon
    puede tener varias piezas, y cada una se clasifica por separado) y le asigna una
    categoria por cada metrica configurada. Ademas, si existe info_tablones.csv,
    agrega los tablones que estan en esa lista pero que NO tienen ninguna lectura
    satelital en el rango (quedan con categoria 'Sin dato' en todas las metricas,
    como una sola fila "fantasma" representando todo el tablon).
    Devuelve (df_ultima, metricas_usadas).
    """
    # Dato mas cercano en fecha: si existe historico_retenido.csv (el robot diario guarda
    # ahi, por pieza y por indice, la ultima lectura anterior al rango del informe), se
    # suma a la busqueda del "ultimo valor por pieza". Asi una pieza sin imagen reciente
    # usa su propio dato mas cercano en vez de quedar sin dato. No cambia el rango de
    # fechas que muestra el informe (se calcula con df_historico).
    if os.path.exists(RUTA_HISTORICO_RETENIDO):
        try:
            retenido = pd.read_csv(RUTA_HISTORICO_RETENIDO, low_memory=False)
            if not retenido.empty:
                df = pd.concat([retenido, df], ignore_index=True, sort=False)
        except Exception as e:
            print(f"⚠ No se pudo leer '{os.path.basename(RUTA_HISTORICO_RETENIDO)}': {e}")
    df = _normalizar_columnas(df)
    metricas = _columnas_disponibles(df)

    if not metricas:
        columnas_sospechosas = [c for c in df.columns if c not in
                                 (COLUMNA_TABLON, COLUMNA_DIVISION, COLUMNA_FECHA_INICIO,
                                  COLUMNA_FECHA_COSECHA, "timestamp", "product_name", "mean")]
        raise ValueError(
            "El historico no contiene ninguna de las metricas configuradas en RANGOS "
            f"({list(RANGOS.keys())}). Revisa que 'productos_list' en la descarga "
            "incluya esos productos y que el archivo tenga esas columnas.\n\n"
            f"Columnas encontradas en el archivo ({len(df.columns)} en total):\n"
            f"{list(df.columns)}\n\n"
            f"Candidatas mas probables (excluyendo las columnas de identificacion): "
            f"{columnas_sospechosas}"
        )

    df_ultima = df.sort_values("timestamp").groupby(COLUMNA_ID_UNICO).tail(1).copy()

    # Cada metrica se actualiza con su ULTIMO VALOR DISPONIBLE por pieza, de forma
    # INDEPENDIENTE (no solo la fila "ultima" combinada de arriba). Esto es
    # necesario porque ahora cada producto se pide en su propia solicitud (ver
    # Descarga_Nax_NewEra.py), y no siempre coinciden en que dias tuvieron imagen -
    # sin esto, si el dia mas reciente de una pieza trajo Humedad pero no NDVI, se
    # perdia el NDVI (quedaba "Sin dato") aunque existiera en una fecha anterior de
    # esa misma pieza.
    for metrica in metricas:
        con_dato = df[df[metrica].notna()].sort_values("timestamp")
        if con_dato.empty:
            continue
        ultimo_valor_por_pieza = con_dato.groupby(COLUMNA_ID_UNICO)[metrica].last()
        df_ultima[metrica] = df_ultima[COLUMNA_ID_UNICO].map(ultimo_valor_por_pieza)

    # El TCA (estimado NAX / real / estimado del ingenio) tiene su propia cadencia de
    # imagen satelital, distinta de NDVI/Humedad/Biomasa (el producto 'yield_sugarcane'
    # no siempre trae dato el mismo dia que los demas). Sin este mismo tratamiento de
    # "ultimo valor disponible por pieza" (igual que arriba para 'metricas'), la fila
    # tail(1) se quedaba con la fecha MAS RECIENTE de la pieza aunque esa fecha
    # especifica no tuviera lectura de TCA, y el TCA terminaba en "Sin dato" para
    # practicamente todas las piezas aunque sí hubiera datos en fechas anteriores.
    for columna_tca in (COLUMNA_TCA_ESTIMADO, COLUMNA_TCA_REAL, COLUMNA_TCA_INGENIO_ESTIMADO):
        if columna_tca not in df.columns:
            continue
        con_dato = df[df[columna_tca].notna()].sort_values("timestamp")
        if con_dato.empty:
            continue
        ultimo_valor_por_pieza = con_dato.groupby(COLUMNA_ID_UNICO)[columna_tca].last()
        df_ultima[columna_tca] = df_ultima[COLUMNA_ID_UNICO].map(ultimo_valor_por_pieza)

    # Agregar tablones de la lista maestra que no tienen NINGUN dato satelital en el rango
    info = _cargar_info_tablones()
    if info is not None:
        tablones_con_dato = set(df_ultima[COLUMNA_TABLON])
        faltantes = [tid for tid in info.index if tid not in tablones_con_dato]
        if faltantes:
            filas_vacias = []
            for tid in faltantes:
                fila_info = info.loc[tid]
                fila = {
                    COLUMNA_TABLON: tid,
                    COLUMNA_PIEZA: "N/D",
                    COLUMNA_ID_UNICO: tid,
                    "timestamp": pd.NaT,
                    COLUMNA_DIVISION: fila_info.get("division", "Todos los tablones"),
                    COLUMNA_FECHA_INICIO: fila_info.get("start_date"),
                    COLUMNA_FECHA_COSECHA: fila_info.get("harvest_date"),
                }
                for metrica in metricas:
                    fila[metrica] = float("nan")
                filas_vacias.append(fila)
            df_ultima = pd.concat([df_ultima, pd.DataFrame(filas_vacias)], ignore_index=True)

    # Cobertura total: agregar los campos del maestro de lotes que nunca tuvieron
    # imagen, y completar los atributos faltantes (area, fecha de inicio, riego...).
    maestro = _cargar_maestro(RUTA_MAESTRO_LOTES)
    if maestro is not None:
        antes = len(df_ultima)
        df_ultima = _completar_con_maestro(df_ultima, maestro, metricas)
        print(f"Maestro de lotes: {len(maestro)} piezas; se agregaron {len(df_ultima) - antes} "
              "piezas que no tenían lectura satelital en el histórico.")
    else:
        print(f"⚠ No se encontró '{os.path.basename(RUTA_MAESTRO_LOTES)}' - el reporte solo cubre los "
              "campos con lectura satelital. Vuelve a descargar para generarlo.")

    # Proyeccion de valores faltantes (cada modelo por separado) y del TCA estimado
    # (las lecturas por debajo de TCA_MINIMO_PLAUSIBLE se tratan como ruido).
    for metrica in metricas:
        df_ultima = _proyectar_faltantes(df_ultima, metrica)
        # Diagnostico: cuantas piezas tienen dato SATELITAL real de este modelo (tras
        # el "ultimo valor disponible por pieza" de mas arriba) frente a las que
        # quedaron proyectadas (mediana de piezas similares) o sin dato alguno. Sirve
        # para distinguir un bug de una escasez real de imagenes para ese producto.
        conteo_origen = df_ultima[f"{metrica}_origen"].value_counts().to_dict()
        print(f"[Diagnóstico {RANGOS[metrica]['nombre']}] Piezas por origen del dato: {conteo_origen}")
    if COLUMNA_TCA_ESTIMADO in df_ultima.columns:
        df_ultima = _proyectar_faltantes(df_ultima, COLUMNA_TCA_ESTIMADO,
                                          etiqueta_observado="Estimado NAX",
                                          valor_minimo=TCA_MINIMO_PLAUSIBLE)

    df_ultima[COLUMNA_ACRES] = pd.to_numeric(df_ultima[COLUMNA_ACRES], errors="coerce")

    for metrica in metricas:
        etiquetas, colores = [], []
        for valor in df_ultima[metrica]:
            etiqueta, color = _clasificar(valor, RANGOS[metrica]["tiers"])
            etiquetas.append(etiqueta)
            colores.append(color)
        df_ultima[f"{metrica}_categoria"] = etiquetas
        df_ultima[f"{metrica}_color"] = colores

    return df_ultima, metricas



def agregar_edad_y_madurante(df_ultima):
    """
    Calcula edad_dias/edad_meses a partir de fecha_inicio (start_date) - esta es la
    base del plan de cosecha/madurante. fecha_cosecha (harvest_date) se completa si
    esta disponible, pero solo como referencia (ya no es necesaria para el plan).
    La fecha de aplicacion de madurante SIEMPRE sale de info_tablones.csv, porque NAX
    no la provee.
    Devuelve (df_ultima, info_disponible: bool) donde info_disponible indica si se
    encontro fecha_inicio (y por lo tanto se puede calcular edad) para al menos un
    tablon.
    """
    df_ultima = df_ultima.copy()
    info = _cargar_info_tablones()

    # completar fecha_inicio / fecha_cosecha faltantes con info_tablones.csv, si existe
    if info is not None:
        for idx in df_ultima.index:
            tid = df_ultima.at[idx, COLUMNA_TABLON]
            if tid in info.index:
                fila_info = info.loc[tid]
                if pd.isna(df_ultima.at[idx, COLUMNA_FECHA_INICIO]) and pd.notna(fila_info.get("start_date")):
                    df_ultima.at[idx, COLUMNA_FECHA_INICIO] = fila_info.get("start_date")
                if pd.isna(df_ultima.at[idx, COLUMNA_FECHA_COSECHA]) and pd.notna(fila_info.get("harvest_date")):
                    df_ultima.at[idx, COLUMNA_FECHA_COSECHA] = fila_info.get("harvest_date")

    hoy = pd.Timestamp.now().normalize()
    df_ultima["edad_dias"] = df_ultima[COLUMNA_FECHA_INICIO].apply(
        lambda f: (hoy - f).days if pd.notna(f) else None)
    df_ultima["edad_meses"] = df_ultima["edad_dias"].apply(
        lambda d: d / DIAS_POR_MES if d is not None else None)
    df_ultima["dias_para_cosecha"] = df_ultima[COLUMNA_FECHA_COSECHA].apply(
        lambda f: (f - hoy).days if pd.notna(f) else None)

    dias_desde_madurante_l, en_ventana_l = [], []
    for tid in df_ultima[COLUMNA_TABLON]:
        f_mad = info.loc[tid].get("fecha_ultima_aplicacion_madurante") if (info is not None and tid in info.index) else None
        if f_mad is not None and pd.notna(f_mad):
            dias_mad = (hoy - f_mad).days
            dias_desde_madurante_l.append(dias_mad)
            en_ventana_l.append(dias_mad < VENTANA_MADURANTE_DIAS)
        else:
            dias_desde_madurante_l.append(None)
            en_ventana_l.append(False)
    df_ultima["dias_desde_madurante"] = dias_desde_madurante_l
    df_ultima["en_ventana_madurante"] = en_ventana_l

    info_disponible = bool(df_ultima["edad_dias"].notna().any())
    return df_ultima, info_disponible


# =====================================================================================
# DEFICIT DE HUMEDAD SEGUN EDAD DEL CULTIVO
# =====================================================================================
# Entre los tablones con humedad baja (categoria de alerta), la edad del cultivo
# (dias desde fecha_inicio) permite distinguir dos situaciones muy distintas:
#   - 8.5 a 9.5 meses: el campo ya esta clasificando para aplicar madurante.
#   - 4 a 6 meses: el campo podria tener estres hidrico por falta de lluvia (todavia
#     no esta cerca de cosecha, asi que la humedad baja ahi SI es un problema).
# EJEMPLO de rangos - ajustar con criterio agronomico si hace falta.
RANGO_EDAD_HUMEDAD_MADURANTE_MESES = (8.5, 9.5)
RANGO_EDAD_ESTRES_MESES = (4.0, 6.0)


def _analisis_humedad_por_edad(df_ultima):
    """De los tablones en la categoria de alerta de humedad, separa los que
    clasifican para madurante (8.5-9.5 meses) de los que podrian tener estres
    hidrico por falta de lluvia (4-6 meses). Devuelve (df_madurante, df_estres),
    cada uno con una columna extra 'edad_meses'."""
    col_cat = f"{COLUMNA_HUMEDAD_ANOMALIA}_categoria"
    if col_cat not in df_ultima.columns or "edad_dias" not in df_ultima.columns:
        return pd.DataFrame(), pd.DataFrame()

    categoria_alerta = RANGOS[COLUMNA_HUMEDAD_ANOMALIA]["tiers"][-1][1]
    df_alerta = df_ultima[df_ultima[col_cat] == categoria_alerta].copy()
    df_alerta = df_alerta[df_alerta["edad_dias"].notna()]
    if df_alerta.empty:
        return pd.DataFrame(), pd.DataFrame()
    df_alerta["edad_meses"] = df_alerta["edad_dias"] / DIAS_POR_MES

    df_madurante = df_alerta[
        (df_alerta["edad_meses"] >= RANGO_EDAD_HUMEDAD_MADURANTE_MESES[0]) &
        (df_alerta["edad_meses"] <= RANGO_EDAD_HUMEDAD_MADURANTE_MESES[1])
    ]
    df_estres = df_alerta[
        (df_alerta["edad_meses"] >= RANGO_EDAD_ESTRES_MESES[0]) &
        (df_alerta["edad_meses"] <= RANGO_EDAD_ESTRES_MESES[1])
    ]
    return df_madurante, df_estres


# COLUMNA_HUMEDAD_ANOMALIA identifica la metrica de humedad para el cruce con edad
# de arriba (_analisis_humedad_por_edad).
COLUMNA_HUMEDAD_ANOMALIA = COLUMNA_HUMEDAD


def _celda(texto, negrita=False, blanco=False, centrado=True, tamano=7.5):
    """Celda de tabla que SIEMPRE ajusta el texto (wrap) al ancho de columna, para
    que los titulos largos (ej. 'Alerta por deficit de humedad') no se amontonen ni
    se corten."""
    estilo = ParagraphStyle(
        f"Celda_{negrita}_{blanco}_{centrado}_{tamano}",
        fontName="Helvetica-Bold" if negrita else "Helvetica",
        fontSize=tamano,
        leading=tamano + 2,
        textColor=colors.white if blanco else colors.HexColor(COLOR_TEXTO),
        alignment=TA_CENTER if centrado else 0,
    )
    return Paragraph(str(texto), estilo)


def _encabezado_seccion(texto, color_fondo=None):
    """Titulo de seccion estilo 'banner': banda de color con texto blanco, en vez de
    un titulo de texto plano - da un aspecto mas de revista/reporte corporativo."""
    color_fondo = color_fondo or COLOR_MARCA_AZUL
    estilo = ParagraphStyle(
        "EncabezadoBanner", fontName="Helvetica-Bold", fontSize=15,
        textColor=colors.white, leading=18,
    )
    banner = Table([[Paragraph(texto, estilo)]], colWidths=[17 * cm])
    banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(color_fondo)),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ]))
    return banner


def _tarjeta_kpi(valor, etiqueta, color_fondo):
    """Una tarjeta grande con un numero y una etiqueta debajo - para el resumen
    ejecutivo, donde lo importante es que se entienda de un vistazo, sin tener que
    leer tablas."""
    estilo_valor = ParagraphStyle(
        "KPIValor", fontName="Helvetica-Bold", fontSize=24,
        textColor=colors.white, alignment=TA_CENTER, leading=28)
    estilo_etiqueta = ParagraphStyle(
        "KPIEtiqueta", fontName="Helvetica", fontSize=9,
        textColor=colors.white, alignment=TA_CENTER, leading=11)
    tabla = Table([[Paragraph(str(valor), estilo_valor)], [Paragraph(etiqueta, estilo_etiqueta)]],
                  colWidths=[4.1 * cm])
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(color_fondo)),
        ("TOPPADDING", (0, 0), (-1, 0), 12),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
        ("BOTTOMPADDING", (0, 1), (-1, 1), 12),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    return tabla


def _fila_tarjetas_kpi(tarjetas):
    """Acomoda varias tarjetas KPI en una sola fila, con espacio entre ellas."""
    fila = Table([tarjetas], colWidths=[4.25 * cm] * len(tarjetas))
    fila.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return fila


def _leyenda_colores(styles):
    """Pequeña leyenda visual explicando el significado de los colores usados en
    todo el reporte (tablas, gráficos y listas), para lectores no familiarizados
    con el sistema de semáforo."""
    filas = [
        ("#2E7D32", "Bien — sin problema, no requiere acción"),
        ("#9E9D24", "Atención — conviene revisar cuando sea posible"),
        ("#EF6C00", "Cuidado — seguimiento cercano recomendado"),
        ("#C62828", "Alerta — requiere acción lo antes posible"),
    ]
    data = []
    for color_hex, texto in filas:
        celda_color = Table([[""]], colWidths=[0.7 * cm], rowHeights=[0.45 * cm])
        celda_color.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(color_hex))]))
        data.append([celda_color, Paragraph(texto, styles["Normal"])])
    tabla = Table(data, colWidths=[1.1 * cm, 15.9 * cm])
    tabla.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return tabla


def _tabla_resumen_modelos(resumenes_modelo):
    """Tabla compacta, estilo dashboard: una fila por modelo con sus numeros clave.
    Reemplaza los parrafos largos - el detalle real esta en cada apartado."""
    data = [[_celda("Modelo", negrita=True, blanco=True, centrado=False),
             _celda("Piezas con dato", negrita=True, blanco=True),
             _celda("% en buena condición", negrita=True, blanco=True),
             _celda("Tablones que requieren atención", negrita=True, blanco=True)]]
    for r in resumenes_modelo:
        if r["con_dato"] == 0:
            continue
        color_atencion = "#C62828" if r["en_peor"] > 0 else COLOR_TEXTO
        celda_atencion = _celda(r["en_peor"], negrita=r["en_peor"] > 0)
        if r["en_peor"] > 0:
            celda_atencion = Paragraph(str(r["en_peor"]), ParagraphStyle(
                "AtencionResumen", fontName="Helvetica-Bold", fontSize=7.5,
                textColor=colors.HexColor(color_atencion), alignment=TA_CENTER))
        data.append([
            _celda(r["nombre"], centrado=False),
            _celda(r["piezas"]),
            _celda(f"{r['pct_bien']}%"),
            celda_atencion,
        ])
    ancho_modelo = 6 * cm
    ancho_resto = (17 * cm - ancho_modelo) / 3
    tabla = Table(data, colWidths=[ancho_modelo] + [ancho_resto] * 3)
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_MARCA_AZUL)),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F2F2")]),
    ]))
    return tabla


# =====================================================================================
# RESUMEN EJECUTIVO
# =====================================================================================
# Pagina "de un vistazo" al inicio del reporte: numeros grandes y frases en lenguaje
# sencillo, para alguien que no esta familiarizado con NAX ni con los modelos.

def _resumen_por_modelo(df_ultima, metrica):
    """Cuenta, para un modelo, cuantos TABLONES (no piezas) tienen dato, cuantos
    estan en la MEJOR categoria y cuantos en la PEOR - la base del resumen en
    lenguaje sencillo. Como cada fila de df_ultima es una PIEZA, un tablon con
    varias piezas se resume asi: 'en_peor' si AL MENOS UNA de sus piezas esta en la
    peor categoria (para no pasar por alto un problema puntual), 'en_mejor' si
    TODAS sus piezas con dato estan en la mejor categoria."""
    info = RANGOS[metrica]
    col_cat = f"{metrica}_categoria"
    mejor = info["tiers"][0][1]
    peor = info["tiers"][-1][1]
    # "Bien" = la mejor categoria y, en modelos de 4 categorias (NDVI, biomasa), tambien la normal.
    buenas = {t[1] for t in info["tiers"][:2 if len(info["tiers"]) >= 4 else 1]}

    con_dato_df = df_ultima[df_ultima[col_cat] != "Sin dato"]
    con_dato = con_dato_df[COLUMNA_TABLON].nunique()
    en_peor = con_dato_df.loc[con_dato_df[col_cat] == peor, COLUMNA_TABLON].nunique()
    en_mejor = 0
    if con_dato:
        todas_en_mejor = con_dato_df.groupby(COLUMNA_TABLON)[col_cat].apply(lambda s: s.isin(buenas).all())
        en_mejor = int(todas_en_mejor.sum())
    # % en buena condicion = PIEZAS en categorias buenas / piezas con dato (igual que el grafico).
    piezas = len(con_dato_df)
    pct_bien = round(100 * con_dato_df[col_cat].isin(buenas).sum() / piezas) if piezas else 0
    return {"nombre": info["nombre"], "con_dato": con_dato, "piezas": piezas, "en_mejor": en_mejor,
            "en_peor": en_peor, "peor_etiqueta": peor, "pct_bien": pct_bien}


def _divisiones_mas_afectadas(df_ultima, metrica, categoria_critica, top_n=3):
    """Nombres de las divisiones con mas PIEZAS en la categoria critica de un
    modelo, para mencionar en la narrativa (ej. 'principalmente en Baigua y Cuyá')."""
    col_cat = f"{metrica}_categoria"
    df_criticos = df_ultima[df_ultima[col_cat] == categoria_critica]
    if df_criticos.empty:
        return []
    conteo = (df_criticos.groupby(COLUMNA_DIVISION, observed=True, dropna=True)
              .size().sort_values(ascending=False))
    # str(d) a proposito: blindaje final para que esta lista SIEMPRE sean textos,
    # sin importar si algo aguas arriba dejo un numero/NaN en la columna de division.
    return [str(d) for d in conteo.head(top_n).index if conteo[d] > 0]


def _lista_en_prosa(elementos):
    """Convierte una lista en texto natural: 'A', 'A y B', 'A, B y C'."""
    elementos = [str(e) for e in elementos]  # blindaje: nunca truena por un no-texto
    if not elementos:
        return ""
    if len(elementos) == 1:
        return elementos[0]
    return ", ".join(elementos[:-1]) + " y " + elementos[-1]


def _pagina_separadora_modelo(nombre, descripcion, color_acento=None):
    """Pagina 'separadora' tipo mini-portada antes de cada modelo, para dejar claro
    donde empieza cada seccion al hojear el reporte. Devuelve una lista de
    flowables (incluye el PageBreak final) para agregar directo al story."""
    color_acento = color_acento or COLOR_MARCA_AZUL
    estilo_titulo = ParagraphStyle(
        "PortadaModeloTitulo", fontName="Helvetica-Bold", fontSize=26,
        textColor=colors.HexColor(COLOR_TEXTO), alignment=TA_CENTER, leading=30)
    estilo_desc = ParagraphStyle(
        "PortadaModeloDesc", fontName="Helvetica", fontSize=11.5,
        textColor=colors.HexColor(COLOR_TEXTO), alignment=TA_CENTER, leading=16)

    elementos = [Spacer(1, 7 * cm), Paragraph(nombre, estilo_titulo), Spacer(1, 12)]
    linea = HRFlowable(width="35%", thickness=2, color=colors.HexColor(color_acento), hAlign="CENTER")
    elementos.append(linea)
    elementos.append(Spacer(1, 18))
    if descripcion:
        celda = Table([[Paragraph(descripcion, estilo_desc)]], colWidths=[13 * cm])
        celda.hAlign = "CENTER"
        elementos.append(celda)
    elementos.append(PageBreak())
    return elementos


# =====================================================================================
# ANALISIS DE TCA: ESTIMADO VS REAL (cuando ya hay cosecha)
# =====================================================================================
# El estimado (COLUMNA_TCA_ESTIMADO) sale del modelo satelital de NAX y deberia estar
# disponible para casi todos los tablones desde ya. El real (COLUMNA_TCA_REAL) lo va
# llenando el ingenio progresivamente, a medida que cierran/cosechan campos en la
# zafra - al inicio de la zafra puede no haber NINGUN valor real todavia. El listado
# detallado va al Excel de casos criticos, no al PDF (ver generar_excel_casos_criticos).

def _tabla_desviacion_tch(df_ultima):
    """Tablones que YA tienen valor real (cosechados), con la diferencia % respecto
    al estimado de NAX, ordenados por MAYOR desviacion absoluta primero."""
    con_real = df_ultima[df_ultima[COLUMNA_TCA_REAL].notna() & df_ultima[COLUMNA_TCA_ESTIMADO].notna()].copy()
    if con_real.empty:
        return pd.DataFrame()
    con_real["diferencia_pct"] = (
        (con_real[COLUMNA_TCA_REAL] - con_real[COLUMNA_TCA_ESTIMADO]) / con_real[COLUMNA_TCA_ESTIMADO] * 100
    )
    con_real = con_real.reindex(con_real["diferencia_pct"].abs().sort_values(ascending=False).index)
    con_real["diferencia_pct"] = con_real["diferencia_pct"].apply(lambda v: f"{v:+.1f}%")
    return con_real


# =====================================================================================
# COMPARACION DE TCA POR EDAD DE CAÑA: CAMPAÑA ACTUAL VS. LA ANTERIOR
# =====================================================================================
# Compara cada modelo (Humedad, NDVI, Biomasa, TCA) entre la campaña actual y la
# anterior. El dato de la campaña anterior sale de un archivo aparte, generado por
# Descarga_Nax_NewEra.py -> download_datos_campana_anterior() (boton "Descargar
# Datos Campaña Anterior"). Si ese archivo no existe todavia, estas comparaciones
# simplemente avisan que falta el dato (o muestran solo la distribucion actual),
# sin romper el resto del reporte.
# NOTA: este archivo se llamaba antes 'historico_tch_campana_anterior.csv' (solo
# traia TCH). Ahora trae TODOS los productos confirmados (NDVI, Humedad, Biomasa y
# TCH) de la campaña anterior, para poder comparar historico vs. zafra actual en
# cada apartado del reporte, no solo en TCA.
RUTA_HISTORICO_CAMPANA_ANTERIOR = os.path.join(_DIRECTORIO_SCRIPT, "historico_campana_anterior.csv")


def _cargar_historico_campana_anterior():
    """Lee el historico de la campaña anterior (todos los productos), si ya se
    descargo. Devuelve None si el archivo no existe todavia."""
    if not os.path.exists(RUTA_HISTORICO_CAMPANA_ANTERIOR):
        return None
    return pd.read_csv(RUTA_HISTORICO_CAMPANA_ANTERIOR)


# Por debajo de este valor, una lectura de TCA se considera RUIDO/ERROR, no un dato
# real - un campo con caña de meses de edad no deberia dar un TCA casi en cero. Esto
# es un EJEMPLO de piso; ajustalo con criterio agronomico si hace falta (el TCA
# historico normal que se ha visto ronda 20-25+ toneladas/acre).
TCA_MINIMO_PLAUSIBLE = 10.0


# =====================================================================================
# TCA POR MANEJO DE RIEGO: CON RIEGO VS SIN RIEGO (campaña actual vs. anterior)
# =====================================================================================
# Los campos SIN riego son mucho mas sensibles a condiciones de sequia (ej. un
# fenomeno de El Niño) que los campos CON riego, que reciben agua sin importar la
# lluvia. Comparar el TCA promedio (ya filtrado de ruido) separado por riego/secano,
# campaña actual vs anterior, ayuda a confirmar si una caida de TCA es coherente con
# lo que se esperaria de las condiciones climaticas de la temporada.

def _ultimo_valor_pieza_campana_anterior(columna, etiqueta_observado="Estimado NAX", valor_minimo=None):
    """Version GENERICA (para cualquier columna/metrica) de lo que antes era solo
    para TCA: ultimo valor POR PIEZA de 'columna' en la campaña anterior (del
    historico satelital de esa campaña), completado con el maestro de lotes de esa
    campaña y proyectado para las piezas sin dato (misma logica que la campaña
    actual). Devuelve None si no hay ningun dato de la campaña anterior en
    absoluto (ni historico ni maestro) para completar nada."""
    partes = []
    df_hist = _cargar_historico_campana_anterior()
    if df_hist is not None and not df_hist.empty:
        hist = _normalizar_columnas(df_hist)
        if columna in hist.columns:
            con_dato = hist[hist[columna].notna()].sort_values("timestamp")
            if not con_dato.empty:
                partes.append(con_dato.groupby(COLUMNA_ID_UNICO).tail(1))
    maestro_ant = _cargar_maestro(RUTA_MAESTRO_LOTES_ANTERIOR)
    if not partes and maestro_ant is None:
        return None
    base = partes[0] if partes else maestro_ant.iloc[0:0].copy()
    if maestro_ant is not None:
        base = _completar_con_maestro(base, maestro_ant, metricas=[columna])
    if columna not in base.columns:
        base[columna] = float("nan")
    return _proyectar_faltantes(base, columna, etiqueta_observado=etiqueta_observado,
                                valor_minimo=valor_minimo)


def _tca_por_pieza_campana_anterior():
    """TCA estimado POR PIEZA de la campaña anterior (ver _ultimo_valor_pieza_campana_anterior)."""
    return _ultimo_valor_pieza_campana_anterior(COLUMNA_TCA_ESTIMADO, etiqueta_observado="Estimado NAX",
                                                valor_minimo=TCA_MINIMO_PLAUSIBLE)


def _metrica_por_pieza_campana_anterior(metrica):
    """Ultimo valor POR PIEZA de una metrica de RANGOS (Humedad/NDVI/Biomasa) en la
    campaña anterior (ver _ultimo_valor_pieza_campana_anterior)."""
    return _ultimo_valor_pieza_campana_anterior(metrica)


# =====================================================================================
# COMPARACION POR MODELO: DISTRIBUCION REAL DE VALORES, CAMPAÑA ANTERIOR VS. ACTUAL
# =====================================================================================
# En vez de reducir cada modelo a un % en cada categoria (barras apiladas) o a un
# grafico de torta, se grafica la distribucion REAL de valores (boxplot: mediana,
# cuartiles, rango y valores atipicos) de la campaña anterior vs. la actual, con
# lineas de referencia horizontales marcando los umbrales de RANGOS - asi se ve de
# un vistazo no solo si "mejoro o empeoro", sino tambien que tan dispersos estan
# los datos y donde caen respecto al semaforo de decision. Solo se usan valores
# CON lectura satelital real (no proyectados) para que la caja refleje la
# variabilidad real del cultivo, no el relleno de piezas sin dato.

def _valores_observados(df, metrica):
    """Valores de 'metrica' con lectura satelital real (no proyectados/rellenados
    por similitud) - para graficos de distribucion, donde mezclar valores
    proyectados (todos iguales a una mediana) distorsionaria la dispersion real."""
    if df is None or metrica not in df.columns:
        return pd.Series(dtype=float)
    valores = pd.to_numeric(df[metrica], errors="coerce")
    col_origen = f"{metrica}_origen"
    if col_origen in df.columns:
        valores = valores.where(df[col_origen] != ORIGEN_PROYECTADO)
    return valores.dropna()


def _grafico_dona(df_ultima, metrica, carpeta_tmp):
    """Grafico de dona (torta): proporcion de piezas de la campaña actual en cada
    categoria de 'metrica' (Bien/Revisar/Alerta, etc.). Complementa el boxplot
    (que muestra la distribucion de VALORES) con una vista rapida y colorida de la
    distribucion de CATEGORIAS - mas facil de leer de un vistazo para quien
    prefiere ver el semaforo general antes de entrar en el detalle estadistico."""
    tiers = RANGOS[metrica]["tiers"]
    cuentas = df_ultima[f"{metrica}_categoria"].value_counts()
    orden = [t[1] for t in tiers]
    colores_tier = {t[1]: t[2] for t in tiers}

    datos = [(cat, int(cuentas.get(cat, 0)), colores_tier.get(cat, "#888888"))
             for cat in orden if cat != "Sin dato" and cuentas.get(cat, 0) > 0]
    if not datos:
        return None
    etiquetas, valores, colores_f = zip(*datos)
    total = sum(valores)

    fig, ax = plt.subplots(figsize=(6.2, 5.4))
    wedges, _, autotextos = ax.pie(
        valores, colors=colores_f, startangle=90,
        autopct=lambda p: f"{p:.0f}%" if p >= 4 else "",
        pctdistance=0.78,
        wedgeprops={"width": 0.42, "edgecolor": "white", "linewidth": 1.5})
    for t in autotextos:
        t.set_color("white")
        t.set_fontsize(12)
        t.set_fontweight("bold")

    ax.set_title(f"{RANGOS[metrica]['nombre']}: distribución por categoría ({total} piezas)", fontsize=12)
    ax.legend(wedges, etiquetas, loc="center left", bbox_to_anchor=(1, 0.5), fontsize=10.5)
    ax.axis("equal")
    fig.tight_layout()
    ruta = os.path.join(carpeta_tmp, f"dona_{metrica}.png")
    fig.savefig(ruta, dpi=150, bbox_inches="tight")
    plt.close(fig)
    return ruta


def _grafico_distribucion_metrica(df_ultima, metrica, carpeta_tmp):
    """Boxplot de la distribucion real de 'metrica': campaña anterior vs. actual
    cuando hay suficientes datos reales de la anterior, o solo la actual como
    respaldo (nunca se queda sin grafico ni cae de vuelta a una torta). Devuelve
    un dict con 'ruta', 'usa_comparacion', 'mediana_actual', 'mediana_anterior'
    (None si no aplica), 'n_actual' y 'n_anterior'; o None si ni la campaña
    actual tiene suficientes datos reales para graficar."""
    valores_actual = _valores_observados(df_ultima, metrica)
    if len(valores_actual) < 5:
        return None

    df_anterior = _metrica_por_pieza_campana_anterior(metrica)
    valores_anterior = _valores_observados(df_anterior, metrica)
    usa_comparacion = len(valores_anterior) >= 5

    conjuntos = [valores_anterior, valores_actual] if usa_comparacion else [valores_actual]
    etiquetas_x = (["Campaña\nAnterior", "Campaña\nActual"] if usa_comparacion
                   else ["Campaña Actual"])
    colores_cajas = (["#9AA7B0", COLOR_MARCA_AZUL] if usa_comparacion else [COLOR_MARCA_AZUL])

    fig, ax = plt.subplots(figsize=(7.2 if usa_comparacion else 5.6, 5))
    caja = ax.boxplot(
        conjuntos, patch_artist=True, widths=0.4, showmeans=True,
        medianprops={"color": COLOR_TEXTO, "linewidth": 1.8},
        meanprops={"marker": "D", "markerfacecolor": "white",
                   "markeredgecolor": COLOR_TEXTO, "markersize": 6},
        whiskerprops={"color": COLOR_TEXTO}, capprops={"color": COLOR_TEXTO},
        flierprops={"marker": "o", "markersize": 3, "markerfacecolor": "#B0B0B0",
                    "markeredgecolor": "none", "alpha": 0.6})
    for parche, color in zip(caja["boxes"], colores_cajas):
        parche.set_facecolor(color)
        parche.set_alpha(0.78)
    ax.set_xticks(range(1, len(conjuntos) + 1))
    ax.set_xticklabels(etiquetas_x, fontsize=12)

    # Lineas de referencia horizontales con los umbrales de categoria (semaforo),
    # para ver donde cae cada campaña respecto a la decision, no solo el numero.
    # La LINEA se dibuja siempre en el valor real del umbral; el TEXTO de la
    # etiqueta se separa verticalmente si dos umbrales quedan muy cerca (ej. NDVI
    # 0.57/0.53/0.50), para que no se amontonen y se vuelvan ilegibles.
    todos_los_valores = pd.concat(conjuntos)
    minimo_datos, maximo_datos = todos_los_valores.min(), todos_los_valores.max()
    margen = (maximo_datos - minimo_datos) * 0.15 or (abs(maximo_datos) * 0.1 or 1)
    umbrales_visibles = []
    for umbral, etiqueta, color in RANGOS[metrica]["tiers"]:
        if umbral == float("-inf"):
            continue
        if minimo_datos - margen <= umbral <= maximo_datos + margen:
            ax.axhline(umbral, color=color, linestyle="--", linewidth=1.2, alpha=0.85, zorder=0)
            umbrales_visibles.append({"y": umbral, "etiqueta": etiqueta, "color": color})

    rango_eje = (maximo_datos + margen) - (minimo_datos - margen)
    separacion_minima = rango_eje * 0.08
    # La etiqueta se ancla un poco POR ENCIMA de su propia linea (en vez de
    # centrada sobre ella) y se dibuja con va="bottom" - si no, la linea
    # punteada atraviesa el texto por la mitad y lo vuelve ilegible (se veia
    # como tachado). El offset es chico a proposito: solo lo suficiente para
    # despegar el texto de su propia linea, sin afectar la logica de
    # separacion entre etiquetas distintas que esta debajo.
    offset_propio = rango_eje * 0.012
    umbrales_visibles.sort(key=lambda d: -d["y"])
    y_texto_anterior = None
    for item in umbrales_visibles:
        y_texto = item["y"] + offset_propio
        if y_texto_anterior is not None and (y_texto_anterior - y_texto) < separacion_minima:
            y_texto = y_texto_anterior - separacion_minima
        item["y_texto"] = y_texto
        y_texto_anterior = y_texto
    for item in umbrales_visibles:
        ax.text(len(conjuntos) + 0.55, item["y_texto"], item["etiqueta"], color=item["color"],
                fontsize=8.5, va="bottom", fontweight="bold")

    ax.set_xlim(0.5, len(conjuntos) + 1.35)
    ax.set_ylim(minimo_datos - margen, maximo_datos + margen)
    ax.set_ylabel(RANGOS[metrica]["nombre"], fontsize=11.5)
    titulo = f"{RANGOS[metrica]['nombre']}: distribución real" + (
        " — campaña anterior vs. actual" if usa_comparacion else " (campaña actual)")
    ax.set_title(titulo, fontsize=12.5)
    ax.tick_params(axis="y", labelsize=10)
    fig.tight_layout()
    ruta = os.path.join(carpeta_tmp, f"distribucion_{metrica}.png")
    fig.savefig(ruta, dpi=150, bbox_inches="tight")
    plt.close(fig)

    return {
        "ruta": ruta,
        "usa_comparacion": usa_comparacion,
        "media_actual": float(valores_actual.mean()),
        "media_anterior": float(valores_anterior.mean()) if usa_comparacion else None,
        "mediana_actual": float(valores_actual.median()),
        "mediana_anterior": float(valores_anterior.median()) if usa_comparacion else None,
        "desviacion_actual": float(valores_actual.std()),
        "desviacion_anterior": float(valores_anterior.std()) if usa_comparacion else None,
        "n_actual": int(len(valores_actual)),
        "n_anterior": int(len(valores_anterior)) if usa_comparacion else 0,
    }


def _celda_variacion(valor_pct, tamano=7.5):
    """Celda de tabla para un % de variacion, resaltada en verde (mejora, valor
    mas alto = mejor segun el orden de RANGOS) o rojo (deterioro)."""
    if valor_pct is None:
        return _celda("N/D", tamano=tamano)
    color = "#2E7D32" if valor_pct >= 0 else "#C62828"
    signo = "+" if valor_pct >= 0 else ""
    estilo = ParagraphStyle(
        f"CeldaVariacion_{tamano}", fontName="Helvetica-Bold", fontSize=tamano,
        leading=tamano + 2, textColor=colors.HexColor(color), alignment=TA_CENTER)
    return Paragraph(f"{signo}{valor_pct:.1f}%", estilo)


def _tabla_distribucion_metrica(distribucion):
    """Tabla resumen: Media, Mediana y Desviación estándar de una metrica, campaña
    anterior vs. actual, con la Variación (%) resaltada en verde/rojo. Complementa
    el boxplot con los numeros exactos, para quien prefiera leer la tabla en vez de
    (o ademas de) interpretar la grafica."""
    filas_stats = [
        ("Media", distribucion.get("media_anterior"), distribucion.get("media_actual")),
        ("Mediana", distribucion.get("mediana_anterior"), distribucion.get("mediana_actual")),
        ("Desviación estándar", distribucion.get("desviacion_anterior"), distribucion.get("desviacion_actual")),
    ]
    data = [[_celda("Estadística", negrita=True, blanco=True, centrado=False),
             _celda("Campaña Anterior", negrita=True, blanco=True),
             _celda("Campaña Actual", negrita=True, blanco=True),
             _celda("Variación", negrita=True, blanco=True)]]
    for nombre_stat, valor_anterior, valor_actual in filas_stats:
        if valor_anterior is None or valor_actual is None:
            continue
        # La desviacion estandar no tiene un "mejor/peor" claro (mas alto no es
        # necesariamente malo), asi que esa fila no se resalta en verde/rojo.
        if nombre_stat == "Desviación estándar":
            variacion_pct = ((valor_actual - valor_anterior) / valor_anterior * 100
                              if valor_anterior else None)
            celda_variacion = (_celda(f"{variacion_pct:+.1f}%") if variacion_pct is not None
                                else _celda("N/D"))
        else:
            variacion_pct = ((valor_actual - valor_anterior) / valor_anterior * 100
                              if valor_anterior else None)
            celda_variacion = _celda_variacion(variacion_pct)
        data.append([_celda(nombre_stat, centrado=False), _celda(f"{valor_anterior:.2f}"),
                     _celda(f"{valor_actual:.2f}"), celda_variacion])
    ancho_col = 17 * cm / 4
    tabla = Table(data, colWidths=[ancho_col] * 4)
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_MARCA_AZUL)),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F2F2")]),
    ]))
    return tabla


def _diagnostico_tca_por_riego(df_piezas, etiqueta_campana):
    """Imprime en la terminal, por riego, cuantas piezas tienen TCA estimado propio y
    cuantas quedaron proyectadas - para entender de donde sale cada numero."""
    if df_piezas is None or COLUMNA_TCA_ESTIMADO not in df_piezas.columns:
        print(f"[Diagnóstico TCA - {etiqueta_campana}] Sin datos de TCA.")
        return
    col_origen = f"{COLUMNA_TCA_ESTIMADO}_origen"
    tabla = df_piezas.groupby([df_piezas[COLUMNA_ES_REGADO].astype(str), df_piezas[col_origen]]).size()
    print(f"[Diagnóstico TCA - {etiqueta_campana}] Piezas por riego (0=sin riego, 1=con riego) y "
          f"origen del dato: {tabla.to_dict()}")


def _tca_por_riego(df_piezas):
    """Mediana de TCA POR PIEZA, separada en con riego (1) / sin riego (0). Devuelve
    {0: valor, 1: valor}; una llave puede faltar si no hay piezas de ese grupo."""
    if df_piezas is None:
        return {}
    datos = df_piezas.dropna(subset=[COLUMNA_TCA_ESTIMADO, COLUMNA_ES_REGADO])
    if datos.empty:
        return {}
    riego = pd.to_numeric(datos[COLUMNA_ES_REGADO], errors="coerce")
    return datos.groupby(riego)[COLUMNA_TCA_ESTIMADO].median().to_dict()


def _comparacion_tca_por_riego(df_ultima):
    """Compara CON riego / SIN riego, campaña actual (df_ultima, ya con proyeccion)
    vs anterior. Devuelve una lista de dicts por manejo con zafra_anterior,
    zafra_actual y variacion_pct (None si falta algun dato)."""
    _diagnostico_tca_por_riego(df_ultima, "Campaña actual")
    tca_actual = _tca_por_riego(df_ultima)

    df_anterior = _tca_por_pieza_campana_anterior()
    _diagnostico_tca_por_riego(df_anterior, "Campaña anterior")
    tca_anterior = _tca_por_riego(df_anterior)

    filas = []
    for es_regado, etiqueta in [(0, "Sin Riego"), (1, "Con Riego")]:
        actual = tca_actual.get(es_regado)
        anterior = tca_anterior.get(es_regado)
        variacion = None
        if actual is not None and anterior:
            variacion = (actual - anterior) / anterior * 100
        filas.append({"manejo": etiqueta, "zafra_anterior": anterior,
                      "zafra_actual": actual, "variacion_pct": variacion})
    return filas


def _grafico_tca_por_riego(filas_comparacion, carpeta_tmp):
    """Barras agrupadas: TCA por manejo de riego (Sin Riego / Con Riego), campaña
    actual vs anterior. Devuelve None si no hay ningun dato para graficar."""
    filas_con_dato = [f for f in filas_comparacion
                       if f["zafra_actual"] is not None or f["zafra_anterior"] is not None]
    if not filas_con_dato:
        return None

    posiciones = list(range(len(filas_con_dato)))
    ancho = 0.35
    valores_anterior = [f["zafra_anterior"] or 0 for f in filas_con_dato]
    valores_actual = [f["zafra_actual"] or 0 for f in filas_con_dato]

    fig, ax = plt.subplots(figsize=(7.5, 4.5))
    ax.bar([p - ancho / 2 for p in posiciones], valores_anterior, ancho,
           label="Zafra anterior", color=COLOR_TEXTO)
    ax.bar([p + ancho / 2 for p in posiciones], valores_actual, ancho,
           label="Zafra actual", color=COLOR_MARCA_AZUL)
    ax.set_xticks(posiciones)
    ax.set_xticklabels([f["manejo"] for f in filas_con_dato], fontsize=12)
    ax.set_ylabel("TCA estimado (mediana)", fontsize=12)
    ax.set_title("TCA por manejo de riego: campaña actual vs. anterior", fontsize=13)
    ax.tick_params(axis="both", labelsize=11)
    ax.legend(fontsize=11)
    fig.tight_layout()
    ruta = os.path.join(carpeta_tmp, "tca_por_riego.png")
    fig.savefig(ruta, dpi=150)
    plt.close(fig)
    return ruta


def _tabla_tca_por_division(df_ultima):
    """Tabla 'TCA promedio por división' (campaña actual), al estilo de la tabla
    dinámica de Excel que ya se maneja en el departamento ('Etiquetas de fila' /
    'Promedio de TCA NAX') - con Higueral y Baigua discriminadas en (R)/(S), en
    vez de solo el agregado Con Riego/Sin Riego de toda la operación. No depende
    de la campaña anterior (es una sola columna de datos, no una comparación).

    Desde que el ingenio empezo a cargar su propio estimado de TCA
    (COLUMNA_TCA_INGENIO_ESTIMADO, el campo 'estimated_crop_yield' de NAX - NO es un
    estimado satelital pese al nombre, es la proyeccion propia del ingenio) en la
    data de 2026, se agregan dos columnas mas: el promedio del ingenio por division
    y la diferencia % del ingenio respecto a NAX (mismo criterio que
    _tabla_desviacion_tch: (ingenio - NAX) / NAX * 100). Si una division todavia no
    tiene dato del ingenio, esas dos columnas muestran 'N/D' para esa fila, pero la
    columna de NAX se sigue mostrando igual que antes.

    Devuelve None si no hay TCA estimado (NAX) para ninguna pieza."""
    datos = df_ultima.dropna(subset=[COLUMNA_TCA_ESTIMADO])
    if datos.empty:
        return None
    datos = _con_division_ordenada(datos)
    promedios_nax = datos.groupby(COLUMNA_DIVISION, observed=True)[COLUMNA_TCA_ESTIMADO].mean().dropna()
    if promedios_nax.empty:
        return None
    promedios_ingenio = (
        datos.dropna(subset=[COLUMNA_TCA_INGENIO_ESTIMADO])
        .groupby(COLUMNA_DIVISION, observed=True)[COLUMNA_TCA_INGENIO_ESTIMADO].mean()
    )

    data = [[_celda("División", negrita=True, blanco=True, centrado=False),
             _celda("Promedio de TCA Ingenio", negrita=True, blanco=True),
             _celda("Promedio de TCA NAX", negrita=True, blanco=True),
             _celda("Diferencia", negrita=True, blanco=True)]]
    for division, valor_nax in promedios_nax.items():
        valor_ingenio = promedios_ingenio.get(division)
        tiene_ingenio = valor_ingenio is not None and not pd.isna(valor_ingenio)
        diferencia_pct = ((valor_ingenio - valor_nax) / valor_nax * 100) if tiene_ingenio else None
        data.append([
            _celda(str(division), centrado=False),
            _celda(f"{valor_ingenio:.2f}" if tiene_ingenio else "N/D"),
            _celda(f"{valor_nax:.2f}"),
            _celda_variacion(diferencia_pct),
        ])

    total_nax = datos[COLUMNA_TCA_ESTIMADO].mean()
    total_ingenio = (datos[COLUMNA_TCA_INGENIO_ESTIMADO].mean()
                     if datos[COLUMNA_TCA_INGENIO_ESTIMADO].notna().any() else None)
    tiene_total_ingenio = total_ingenio is not None and not pd.isna(total_ingenio)
    diferencia_total_pct = ((total_ingenio - total_nax) / total_nax * 100) if tiene_total_ingenio else None
    data.append([
        _celda("Total general", negrita=True, centrado=False),
        _celda(f"{total_ingenio:.2f}" if tiene_total_ingenio else "N/D", negrita=True),
        _celda(f"{total_nax:.2f}", negrita=True),
        _celda_variacion(diferencia_total_pct),
    ])

    ancho_col = 17 * cm / 4
    # repeatRows=1: si la tabla no cabe entera en la pagina y ReportLab la corta,
    # repite la fila de encabezado al inicio de la pagina siguiente (son 9 divisiones
    # + total, no siempre entra en lo que queda de la pagina).
    tabla = Table(data, colWidths=[ancho_col * 1.4, ancho_col * 0.87, ancho_col * 0.87, ancho_col * 0.86],
                  repeatRows=1)
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_MARCA_AZUL)),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#F2F2F2")]),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#DCE6F1")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
    ]))
    return tabla


def _tabla_tca_por_riego(filas_comparacion):
    """Tabla: Manejo | Zafra Anterior | Zafra Actual | Variación (%)."""
    data = [[_celda("Manejo", negrita=True, blanco=True, centrado=False),
             _celda("Zafra Anterior", negrita=True, blanco=True),
             _celda("Zafra Actual", negrita=True, blanco=True),
             _celda("Variación (%)", negrita=True, blanco=True)]]
    for f in filas_comparacion:
        anterior_txt = f"{f['zafra_anterior']:.2f}" if f["zafra_anterior"] is not None else "N/D"
        actual_txt = f"{f['zafra_actual']:.2f}" if f["zafra_actual"] is not None else "N/D"
        variacion_txt = f"{f['variacion_pct']:+.2f}%" if f["variacion_pct"] is not None else "N/D"
        data.append([_celda(f["manejo"], centrado=False), _celda(anterior_txt),
                     _celda(actual_txt), _celda(variacion_txt)])
    ancho_col = 17 * cm / 4
    tabla = Table(data, colWidths=[ancho_col] * 4)
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_MARCA_AZUL)),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F2F2")]),
    ]))
    return tabla


def _pie_pagina_interior(canvas, doc):
    """Encabezado/pie de pagina para todas las paginas EXCEPTO la portada."""
    canvas.saveState()
    ancho_pagina, alto_pagina = letter

    # barra superior de color
    canvas.setFillColor(colors.HexColor(COLOR_MARCA_AZUL))
    canvas.rect(0, alto_pagina - 0.5 * cm, ancho_pagina, 0.5 * cm, fill=1, stroke=0)

    # logo pequeno arriba a la izquierda
    if os.path.exists(RUTA_LOGO):
        logo_ancho, logo_alto = _dimensiones_logo(2.5 * cm)
        canvas.drawImage(RUTA_LOGO, 1.5 * cm, alto_pagina - 0.5 * cm - logo_alto - 0.25 * cm,
                          width=logo_ancho, height=logo_alto,
                          preserveAspectRatio=True, mask='auto')

    # pie de pagina (el numero de pagina lo dibuja _CanvasConTotalPaginas, no aqui)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor(COLOR_TEXTO))
    canvas.drawString(1.5 * cm, 1 * cm, DEPARTAMENTO)
    canvas.restoreState()


def _pie_pagina_portada(canvas, doc):
    """Pie de pagina minimo para la portada (sin repetir el logo grande)."""
    canvas.saveState()
    canvas.restoreState()


class _CanvasConTotalPaginas(canvas_module.Canvas):
    """Canvas que permite mostrar 'Página X de Y'. reportlab no sabe cuantas paginas
    va a tener el documento hasta terminar de construirlo, asi que esta clase guarda
    cada pagina en memoria y, al guardar el PDF (una vez ya se sabe el total), vuelve
    a pasar por todas para dibujar el numero de pagina con el total ya conocido."""

    def __init__(self, *args, **kwargs):
        canvas_module.Canvas.__init__(self, *args, **kwargs)
        self._paginas_guardadas = []

    def showPage(self):
        self._paginas_guardadas.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total_paginas = len(self._paginas_guardadas)
        for estado in self._paginas_guardadas:
            self.__dict__.update(estado)
            self._dibujar_numero_pagina(total_paginas)
            canvas_module.Canvas.showPage(self)
        canvas_module.Canvas.save(self)

    def _dibujar_numero_pagina(self, total_paginas):
        ancho_pagina, _ = letter
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor(COLOR_TEXTO))
        self.drawRightString(ancho_pagina - 1.5 * cm, 1 * cm,
                              f"Página {self._pageNumber} de {total_paginas}")


def generar_excel_casos_criticos(hojas_excel, resumen_modelos_df, ruta_excel):
    """
    Genera el Excel de casos criticos: una pestaña 'Resumen' con los numeros clave
    por modelo, y una pestaña por cada listado de detalle en hojas_excel (division,
    tablon, pieza, valor, categoria). Este archivo va SEPARADO del PDF -- ahi es
    donde vive el detalle completo, para mantener el PDF corto e informativo.
    """
    with pd.ExcelWriter(ruta_excel, engine="openpyxl") as writer:
        resumen_modelos_df.to_excel(writer, sheet_name="Resumen", index=False)
        for nombre_hoja, df_hoja in hojas_excel.items():
            df_hoja = df_hoja.copy()
            columnas_float = df_hoja.select_dtypes(include="float").columns
            df_hoja[columnas_float] = df_hoja[columnas_float].round(2)
            # Excel limita el nombre de hoja a 31 caracteres
            nombre_hoja_valido = nombre_hoja[:31]
            df_hoja.to_excel(writer, sheet_name=nombre_hoja_valido, index=False)

        # Formato: encabezado en negrita con fondo de marca, columnas con ancho automatico
        for nombre_hoja in writer.sheets:
            hoja = writer.sheets[nombre_hoja]
            for celda in hoja[1]:
                celda.font = Font(bold=True, color="FFFFFF", name="Arial")
                celda.fill = PatternFill(start_color=COLOR_MARCA_AZUL.replace("#", ""),
                                          end_color=COLOR_MARCA_AZUL.replace("#", ""), fill_type="solid")
                celda.alignment = Alignment(horizontal="center")
            for i, columna in enumerate(hoja.columns, start=1):
                ancho = max((len(str(c.value)) for c in columna if c.value is not None), default=10)
                hoja.column_dimensions[get_column_letter(i)].width = min(max(ancho + 2, 10), 40)
            hoja.freeze_panes = "A2"

    return ruta_excel


def generar_reporte_pdf(df_historico, ruta_pdf):
    """
    Genera el reporte de campos (cosecha/madurante) a partir del DataFrame historico
    completo. Devuelve la ruta del PDF generado.
    """
    if not os.path.exists(RUTA_LOGO):
        print(f"⚠ AVISO: no se encontró el logo en '{RUTA_LOGO}'. El reporte se genera "
              "igual, pero sin el logo. Coloca el archivo 'CR.png' en esa misma carpeta.")

    falta_columna_riego = COLUMNA_IRRIGATION_ORIGEN not in df_historico.columns
    if falta_columna_riego:
        print(f"⚠ AVISO: no se encontró la columna '{COLUMNA_IRRIGATION_ORIGEN}' en el histórico "
              "descargado. Higueral y Baigua NO se separan en (R)/(S) en este reporte porque el "
              "dato de riego no vino en esta descarga.")
    else:
        conteo_riego = df_historico[COLUMNA_IRRIGATION_ORIGEN].value_counts(dropna=False).to_dict()
        print(f"Valores encontrados en '{COLUMNA_IRRIGATION_ORIGEN}': {conteo_riego}")

    for metrica_esperada in RANGOS:
        if metrica_esperada in df_historico.columns:
            continue
        if metrica_esperada == COLUMNA_HUMEDAD and any(
                ("humid" in c.lower() or "moisture" in c.lower()) for c in df_historico.columns):
            # La columna de Humedad se detecta mas adelante por nombre parecido (ver
            # _normalizar_columnas) y se renombra a COLUMNA_HUMEDAD recien dentro de
            # clasificar_datos - en este punto (antes de esa deteccion) todavia no
            # existe con ese nombre exacto, aunque SI va a aparecer en el reporte.
            # Avisar aqui seria una falsa alarma; solo se avisa si de verdad no hay
            # ninguna columna candidata.
            continue
        print(f"⚠ AVISO: no se encontró la columna '{metrica_esperada}' "
              f"({RANGOS[metrica_esperada]['nombre']}) en el histórico descargado. "
              "Esa sección no aparecerá en el reporte.")

    # Diagnostico temporal: para identificar cual columna trae el nombre de la
    # campaña/zafra (ej. "12/2026 (SUGARCANE)"), candidatas: 'name' y 'label'.
    for col_candidata in ("name", "label"):
        if col_candidata in df_historico.columns:
            valores = df_historico[col_candidata].dropna().unique()[:10]
            print(f"Valores encontrados en '{col_candidata}' (hasta 10): {list(valores)}")

    # Diagnostico temporal: buscar cualquier columna relacionada a TCH/TSH o
    # anomalias (nombres de respuesta aun no confirmados) para poder identificarlas.
    columnas_tch_candidatas = [c for c in df_historico.columns if "tch" in c.lower() or "tsh" in c.lower()
                               or "yield" in c.lower()]
    columnas_anomalias_candidatas = [c for c in df_historico.columns if "anomal" in c.lower()]
    columnas_biomasa_candidatas = [c for c in df_historico.columns if "lai" in c.lower() or "biomass" in c.lower()]
    if columnas_tch_candidatas:
        print(f"Columnas relacionadas a 'tch'/'tsh'/'yield' encontradas: {columnas_tch_candidatas}")
    if columnas_anomalias_candidatas:
        print(f"Columnas relacionadas a 'anomalias' encontradas: {columnas_anomalias_candidatas}")
    if columnas_biomasa_candidatas:
        print(f"Columnas relacionadas a 'lai'/'biomass' encontradas: {columnas_biomasa_candidatas}")

    df_ultima, metricas = clasificar_datos(df_historico)
    df_ultima, info_disponible = agregar_edad_y_madurante(df_ultima)
    anomalias_riego = _contar_anomalias_riego(df_historico)
    df_historico_norm = _normalizar_columnas(df_historico)

    with tempfile.TemporaryDirectory() as carpeta_tmp:
        styles = getSampleStyleSheet()
        # Subir el tamaño de letra base en todo el documento (por defecto reportlab
        # usa 10pt, que se ve muy pequeño en un reporte de solo 4 paginas con mucho
        # texto). Como el resto del codigo usa styles["Normal"]/["Italic"]/["Heading3"]
        # en todos lados, basta con ajustar esto aqui una sola vez.
        styles["Normal"].fontSize = 11
        styles["Normal"].leading = 14.5
        styles["Italic"].fontSize = 11
        styles["Italic"].leading = 14.5
        styles["Heading3"].fontSize = 13

        estilo_critico = ParagraphStyle("Critico", parent=styles["Normal"],
                                         textColor=colors.HexColor("#C62828"))
        estilo_empresa = ParagraphStyle("Empresa", parent=styles["Title"],
                                         alignment=TA_CENTER, textColor=colors.HexColor(COLOR_TEXTO),
                                         fontSize=22, spaceAfter=4)
        estilo_depto = ParagraphStyle("Depto", parent=styles["Normal"],
                                       alignment=TA_CENTER, textColor=colors.HexColor(COLOR_TEXTO),
                                       fontSize=13, spaceAfter=2)
        estilo_subtitulo = ParagraphStyle("Subtitulo", parent=styles["Normal"],
                                           alignment=TA_CENTER, textColor=colors.HexColor(COLOR_MARCA_AZUL),
                                           fontSize=15, spaceAfter=4)
        estilo_centrado = ParagraphStyle("Centrado", parent=styles["Normal"], alignment=TA_CENTER)

        story = []

        # --- Portada ---
        story.append(Spacer(1, 0.8 * cm))
        if os.path.exists(RUTA_LOGO):
            logo_ancho, logo_alto = _dimensiones_logo(5 * cm)
            logo_portada = Image(RUTA_LOGO, width=logo_ancho, height=logo_alto)
            logo_portada.hAlign = "CENTER"
            story.append(logo_portada)
            story.append(Spacer(1, 8))
        story.append(Paragraph(NOMBRE_EMPRESA, estilo_empresa))
        story.append(Paragraph(DEPARTAMENTO, estilo_depto))
        story.append(Paragraph(AREA, estilo_depto))
        story.append(Spacer(1, 4))
        story.append(Paragraph(TITULO_REPORTE, estilo_subtitulo))
        story.append(Spacer(1, 6))
        story.append(HRFlowable(width="60%", thickness=1.5, color=colors.HexColor(COLOR_MARCA_AZUL),
                                 hAlign="CENTER"))
        story.append(Spacer(1, 10))

        fecha_generacion = datetime.now().strftime("%Y-%m-%d %H:%M")
        story.append(Paragraph(
            f"Generado el {fecha_generacion} — Rango de datos: {df_historico['timestamp'].min()} a "
            f"{df_historico['timestamp'].max()}", estilo_centrado))
        story.append(Spacer(1, 3))
        total_acres_portada = df_ultima.drop_duplicates(subset=[COLUMNA_ID_UNICO])[COLUMNA_ACRES].sum()
        estilo_acres_portada = ParagraphStyle(
            "AcresPortada", parent=estilo_centrado, fontName="Helvetica-Bold",
            fontSize=15, textColor=colors.HexColor(COLOR_MARCA_AZUL))
        story.append(Paragraph(f"{total_acres_portada:,.0f} acres analizados", estilo_acres_portada))
        story.append(Spacer(1, 10))

        sin_dato_satelital = 0
        for metrica in metricas:
            sin_dato_satelital = max(sin_dato_satelital,
                                      int((df_ultima[f"{metrica}_categoria"] == "Sin dato").sum()))

        # --- Resumen Ejecutivo: "de un vistazo", en lenguaje sencillo (misma pagina que la portada) ---
        story.append(_encabezado_seccion("Resumen Ejecutivo"))
        story.append(Spacer(1, 6))

        total_tablones = df_ultima[COLUMNA_TABLON].nunique()
        total_acres = df_ultima.drop_duplicates(subset=[COLUMNA_ID_UNICO])[COLUMNA_ACRES].sum()
        resumenes_modelo = [_resumen_por_modelo(df_ultima, m) for m in metricas]
        total_criticos = sum(r["en_peor"] for r in resumenes_modelo)

        tarjetas = [
            _tarjeta_kpi(f"{total_acres:,.0f}", "Acres analizados", COLOR_MARCA_AZUL),
            _tarjeta_kpi(f"{total_tablones:,}", "Tablones analizados", COLOR_MARCA_AZUL),
            _tarjeta_kpi(f"{total_criticos:,}", "Casos que requieren atención<br/>(sumando los 3 modelos)",
                         "#C62828" if total_criticos else "#2E7D32"),
        ]
        story.append(_fila_tarjetas_kpi(tarjetas))
        story.append(Spacer(1, 10))

        story.append(Paragraph("Cómo leer los colores de este reporte:", styles["Heading3"]))
        story.append(Spacer(1, 4))
        story.append(_leyenda_colores(styles))
        story.append(Spacer(1, 6))

        from reportlab.platypus import KeepTogether
        bloque_tabla_modelos = [
            Paragraph(
                "A continuación se evidencia un resumen de cada modelo, que se podrá ver con más "
                "detenimiento en cada apartado:", styles["Heading3"]),
            Spacer(1, 6),
            _tabla_resumen_modelos(resumenes_modelo),
        ]
        story.append(KeepTogether(bloque_tabla_modelos))

        story.append(PageBreak())

        # Cada hoja de este diccionario se exporta como una pestaña del Excel de
        # casos criticos (ver generar_excel_casos_criticos), en vez de listar cada
        # pieza en el PDF - eso es lo que lo mantiene corto.
        hojas_excel = {}

        # --- Una seccion por metrica (narrativa + un grafico compacto, sin pagina aparte) ---
        fecha_min_str = df_historico['timestamp'].min()
        fecha_max_str = df_historico['timestamp'].max()
        es_primer_modelo = True

        for metrica in metricas:
            info = RANGOS[metrica]

            # Se arma cada apartado (texto + grafico + frase de comparacion) en una
            # lista aparte y se agrega al story con KeepTogether al final - asi
            # reportlab mueve el bloque COMPLETO a la siguiente pagina si no cabe
            # entero en la que queda, en vez de partirlo y dejar una sola frase
            # huerfana en una pagina casi en blanco.
            bloque_metrica = []
            bloque_metrica.append(_encabezado_seccion(info["nombre"]))
            bloque_metrica.append(Spacer(1, 6))

            col_cat = f"{metrica}_categoria"
            categoria_critica = _categoria_critica(metrica)
            destaca_lo_mejor = metrica in METRICAS_DESTACAR_MEJOR
            resumen_m = _resumen_por_modelo(df_ultima, metrica)
            divisiones_afectadas = _divisiones_mas_afectadas(df_ultima, metrica, categoria_critica)

            intro_fecha = ""
            if es_primer_modelo:
                intro_fecha = (
                    f"En las fechas comprendidas entre {fecha_min_str} y {fecha_max_str}, "
                    "correspondientes a esta descarga, se evidenciaron las siguientes tendencias en "
                    "los modelos analizados. "
                )
                es_primer_modelo = False

            texto = f"{intro_fecha}{info.get('descripcion', '')}"
            if resumen_m["con_dato"] > 0:
                texto += (
                    f" Del total de {resumen_m['piezas']} piezas analizadas en este período "
                    f"({resumen_m['con_dato']} tablones), "
                    f"{resumen_m['pct_bien']}% se encuentran en buena condición."
                )
            df_criticos = df_ultima[df_ultima[col_cat] == categoria_critica]
            if not df_criticos.empty:
                verbo = "se destacan" if destaca_lo_mejor else "se evidencian"
                texto += (
                    f" Además, {verbo} {len(df_criticos)} piezas en la categoría "
                    f"'{categoria_critica}'"
                )
                if divisiones_afectadas:
                    texto += f", principalmente en {_lista_en_prosa(divisiones_afectadas)}"
                texto += (
                    ". El detalle completo de estos casos — incluyendo el identificador (name), "
                    "variedad, tablón y pieza — está disponible en el Excel adjunto."
                )
                nombre_corto_modelo = info["nombre"].split(" (")[0]
                hojas_excel[f"{nombre_corto_modelo} - Críticos"] = df_criticos[
                    [COLUMNA_ID_UNICO, COLUMNA_VARIEDAD, COLUMNA_TABLON, COLUMNA_PIEZA, metrica, col_cat]
                ].rename(columns={
                    COLUMNA_ID_UNICO: "Name", COLUMNA_VARIEDAD: "Variedad", COLUMNA_TABLON: "Tablón",
                    COLUMNA_PIEZA: "Pieza", metrica: info["nombre"], col_cat: "Categoría"})
            else:
                texto += f" No se evidenciaron piezas en la categoría más crítica ('{categoria_critica}')."
            bloque_metrica.append(Paragraph(texto, styles["Normal"]))
            bloque_metrica.append(Spacer(1, 8))

            # Dona (distribucion por CATEGORIA, vista rapida y colorida) y boxplot
            # (distribucion REAL de valores, campaña anterior vs. actual) UNO AL
            # LADO DEL OTRO, no apilados - asi el apartado completo cabe en una
            # sola pagina y se ven ambas lecturas (categorica y estadistica) juntas.
            ruta_dona = _grafico_dona(df_ultima, metrica, carpeta_tmp)
            distribucion = _grafico_distribucion_metrica(df_ultima, metrica, carpeta_tmp)

            imagen_dona = Image(ruta_dona, width=7.6 * cm, height=6.6 * cm) if ruta_dona else None
            imagen_distribucion = (Image(distribucion["ruta"], width=9.2 * cm, height=6.6 * cm)
                                    if distribucion else None)
            if imagen_dona:
                imagen_dona.hAlign = "CENTER"
            if imagen_distribucion:
                imagen_distribucion.hAlign = "CENTER"

            if imagen_dona and imagen_distribucion:
                tabla_imagenes = Table([[imagen_dona, imagen_distribucion]],
                                       colWidths=[7.9 * cm, 9.5 * cm])
                tabla_imagenes.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ]))
                bloque_metrica.append(tabla_imagenes)
                bloque_metrica.append(Spacer(1, 8))
            elif imagen_dona:
                bloque_metrica.append(imagen_dona)
                bloque_metrica.append(Spacer(1, 8))
            elif imagen_distribucion:
                bloque_metrica.append(imagen_distribucion)
                bloque_metrica.append(Spacer(1, 8))

            if distribucion:
                if distribucion["usa_comparacion"]:
                    bloque_metrica.append(_tabla_distribucion_metrica(distribucion))
                    bloque_metrica.append(Spacer(1, 8))

                    mediana_actual = distribucion["mediana_actual"]
                    mediana_anterior = distribucion["mediana_anterior"]
                    diferencia_pct = ((mediana_actual - mediana_anterior) / mediana_anterior * 100
                                       if mediana_anterior else None)
                    if diferencia_pct is not None:
                        color_dif = "#2E7D32" if diferencia_pct >= 0 else "#C62828"
                        direccion = "por encima" if diferencia_pct >= 0 else "por debajo"
                        bloque_metrica.append(Paragraph(
                            f"<font color='{color_dif}'><b>La mediana de la campaña actual está "
                            f"{abs(diferencia_pct):.1f}% {direccion} de la campaña anterior</b></font> "
                            f"(con {distribucion['n_actual']} y {distribucion['n_anterior']} piezas con "
                            "lectura satelital real, respectivamente).", styles["Normal"]))
                        bloque_metrica.append(Spacer(1, 8))
                else:
                    bloque_metrica.append(Paragraph(
                        f"Mediana actual: {distribucion['mediana_actual']:.2f} "
                        f"({distribucion['n_actual']} piezas con lectura satelital real). "
                        "<i>La comparación con la campaña anterior aparecerá en cuanto se descarguen "
                        "sus datos con el botón \"Descargar Datos Campaña Anterior\".</i>", styles["Normal"]))
                    bloque_metrica.append(Spacer(1, 8))
            else:
                bloque_metrica.append(Paragraph(
                    "Todavía no hay suficientes piezas con lectura satelital real de este modelo en "
                    "este período para graficar su distribución.", styles["Italic"]))
                bloque_metrica.append(Spacer(1, 8))

            # Analisis especial de humedad: cruce con la edad del cultivo, para
            # distinguir campos que clasifican para madurante de campos con posible
            # estres hidrico por falta de lluvia. El listado completo va al Excel.
            if metrica == COLUMNA_HUMEDAD_ANOMALIA:
                df_madurante, df_estres = _analisis_humedad_por_edad(df_ultima)
                columnas_edad = [COLUMNA_ID_UNICO, COLUMNA_VARIEDAD, COLUMNA_TABLON, COLUMNA_PIEZA,
                                  metrica, "edad_meses"]
                encabezados_edad = ["Name", "Variedad", "Tablón", "Pieza", "Humedad", "Edad (meses)"]

                texto_edad = "Cruzando la humedad con la edad del cultivo: "
                partes_edad = []
                if not df_madurante.empty:
                    partes_edad.append(
                        f"{len(df_madurante)} pieza(s) de 8.5–9.5 meses de edad clasifican para "
                        "aplicar madurante")
                    hojas_excel["Humedad - Madurante"] = df_madurante[columnas_edad].rename(
                        columns=dict(zip(columnas_edad, encabezados_edad)))
                if not df_estres.empty:
                    partes_edad.append(
                        f"{len(df_estres)} pieza(s) de 4–6 meses muestran posible estrés hídrico por "
                        "falta de lluvia")
                    hojas_excel["Humedad - Estrés Hídrico"] = df_estres[columnas_edad].rename(
                        columns=dict(zip(columnas_edad, encabezados_edad)))
                if partes_edad:
                    texto_edad += "; ".join(partes_edad) + " — ver Excel adjunto para el detalle."
                else:
                    texto_edad += "no se encontraron piezas en esos rangos de edad por ahora."
                bloque_metrica.append(Paragraph(texto_edad, styles["Normal"]))
                bloque_metrica.append(Spacer(1, 10))
            else:
                bloque_metrica.append(Spacer(1, 6))

            story.append(KeepTogether(bloque_metrica))

        story.append(PageBreak())

        # --- Analisis de TCA: comparacion por manejo de riego (actual vs. anterior) ---
        story.append(_encabezado_seccion("TCA: Comparación por Manejo de Riego"))
        story.append(Spacer(1, 8))
        story.append(Paragraph(
            "Este análisis compara el TCA estimado por NAX entre campos con y sin riego, campaña "
            "actual vs. la anterior. Los campos sin riego dependen de la lluvia y son más sensibles "
            "a condiciones climáticas adversas (ej. un fenómeno de El Niño), mientras que los campos "
            "con riego reciben agua sin importar la lluvia — separar la comparación así ayuda a "
            "confirmar si una caída de TCA es coherente con lo que se esperaría del clima de la "
            "temporada, en vez de mezclar ambos manejos en un solo número.", styles["Normal"]))
        story.append(Spacer(1, 8))

        if _cargar_historico_campana_anterior() is None and not os.path.exists(RUTA_MAESTRO_LOTES_ANTERIOR):
            story.append(Paragraph(
                "Esta comparación requiere los datos de la campaña anterior, descargados aparte con el "
                "botón \"Descargar Datos Campaña Anterior\". Esos archivos todavía no se han generado.",
                styles["Normal"]))
        else:
            comparacion_riego = _comparacion_tca_por_riego(df_ultima)
            ruta_tca_riego = _grafico_tca_por_riego(comparacion_riego, carpeta_tmp)
            if ruta_tca_riego:
                story.append(Image(ruta_tca_riego, width=13 * cm, height=7.8 * cm))
                story.append(Spacer(1, 8))
                story.append(_tabla_tca_por_riego(comparacion_riego))
                story.append(Spacer(1, 8))

                for fila in comparacion_riego:
                    if fila["variacion_pct"] is None:
                        continue
                    color_dif = "#2E7D32" if fila["variacion_pct"] >= 0 else "#C62828"
                    direccion = "por encima" if fila["variacion_pct"] >= 0 else "por debajo"
                    story.append(Paragraph(
                        f"<font color='{color_dif}'><b>{fila['manejo']}: el TCA estimado de la campaña "
                        f"actual está {abs(fila['variacion_pct']):.1f}% {direccion} del de la campaña "
                        f"anterior</b></font> ({fila['zafra_actual']:.2f} vs. {fila['zafra_anterior']:.2f} "
                        "TCA).", styles["Normal"]))
                    story.append(Spacer(1, 4))

                # Si "Sin Riego" cayo mas que "Con Riego", es el patron esperable en un año con
                # menos lluvia (ej. El Niño) - se menciona como posible explicacion, no un hecho
                # confirmado, ya que este reporte no verifica las condiciones climaticas reales.
                por_manejo = {f["manejo"]: f["variacion_pct"] for f in comparacion_riego}
                if por_manejo.get("Sin Riego") is not None and por_manejo.get("Con Riego") is not None:
                    if por_manejo["Sin Riego"] < por_manejo["Con Riego"]:
                        story.append(Paragraph(
                            "<i>Los campos sin riego muestran una caída mayor que los campos con riego, "
                            "un patrón consistente con una temporada de menor lluvia (ej. un fenómeno de "
                            "El Niño) — se recomienda confirmar con las condiciones climáticas reales de "
                            "la temporada antes de tomar acción.</i>", styles["Normal"]))
                        story.append(Spacer(1, 6))
            else:
                story.append(Paragraph(
                    "No se encontraron piezas con TCA estimado (por encima del umbral de ruido) en la "
                    "campaña actual o la anterior, separadas por riego/secano.", styles["Normal"]))

        # --- TCA promedio por division (Higueral y Baigua discriminadas en (R)/(S)) ---
        # Es solo de la campaña actual (no requiere datos de la campaña anterior), al
        # estilo de la tabla dinamica de Excel que ya se maneja en el departamento.
        tabla_tca_division = _tabla_tca_por_division(df_ultima)
        if tabla_tca_division:
            story.append(Spacer(1, 10))
            story.append(Paragraph(
                "<b>TCA promedio por división</b> (Higueral y Baigua discriminadas por riego), "
                "comparando el estimado de NAX contra el del ingenio donde ya está disponible:",
                styles["Normal"]))
            story.append(Spacer(1, 6))
            story.append(tabla_tca_division)
            story.append(Spacer(1, 8))

        if df_ultima[COLUMNA_TCA_REAL].notna().any():
            df_desviacion = _tabla_desviacion_tch(df_ultima)
            if not df_desviacion.empty:
                columnas_tca_excel = [COLUMNA_ID_UNICO, COLUMNA_VARIEDAD, COLUMNA_TABLON, COLUMNA_PIEZA,
                                       COLUMNA_TCA_ESTIMADO, COLUMNA_TCA_REAL, "diferencia_pct"]
                hojas_excel["TCA - Estimado vs Real"] = df_desviacion[columnas_tca_excel].rename(columns={
                    COLUMNA_ID_UNICO: "Name", COLUMNA_VARIEDAD: "Variedad", COLUMNA_TABLON: "Tablón",
                    COLUMNA_PIEZA: "Pieza", COLUMNA_TCA_ESTIMADO: "TCA Estimado",
                    COLUMNA_TCA_REAL: "TCA Real", "diferencia_pct": "Diferencia"})

        # --- Cierre (misma pagina, sin salto aparte) ---
        estilo_gracias = ParagraphStyle(
            "Gracias", parent=styles["Normal"], alignment=TA_CENTER,
            fontSize=11, textColor=colors.HexColor(COLOR_TEXTO))
        story.append(Spacer(1, 18))
        story.append(HRFlowable(width="40%", thickness=1, color=colors.HexColor(COLOR_MARCA_AZUL),
                                 hAlign="CENTER"))
        story.append(Spacer(1, 10))
        story.append(Paragraph(f"Gracias por su atención. — {DEPARTAMENTO}", estilo_gracias))

        doc = SimpleDocTemplate(ruta_pdf, pagesize=letter,
                                 topMargin=2.2 * cm, bottomMargin=1.8 * cm)
        doc.build(story, onFirstPage=_pie_pagina_portada, onLaterPages=_pie_pagina_interior,
                  canvasmaker=_CanvasConTotalPaginas)

        # --- Excel de casos criticos (detalle completo, separado del PDF) ---
        resumen_modelos_df = pd.DataFrame([
            {"Modelo": r["nombre"], "Piezas con dato": r["piezas"],
             "% en buena condición": r["pct_bien"], "Tablones que requieren atención": r["en_peor"]}
            for r in resumenes_modelo
        ])
        ruta_excel = os.path.splitext(ruta_pdf)[0] + "_casos_criticos.xlsx"
        generar_excel_casos_criticos(hojas_excel, resumen_modelos_df, ruta_excel)

    return ruta_pdf, ruta_excel


def generar_reporte_desde_csv(ruta_csv, ruta_pdf=None):
    """
    Lee un historico CSV (el mismo generado por transformacion.agregar_a_historico)
    y genera el reporte: un PDF corto e informativo, y un Excel aparte con el
    detalle completo de los casos críticos de cada índice. Si no se indica ruta_pdf,
    se guarda junto al CSV con el mismo nombre y sufijo "_reporte.pdf" (el Excel usa
    el mismo nombre base, con sufijo "_casos_criticos.xlsx").
    Devuelve (ruta_pdf, ruta_excel).
    """
    df = pd.read_csv(ruta_csv)
    if ruta_pdf is None:
        ruta_pdf = os.path.splitext(ruta_csv)[0] + "_reporte.pdf"
    return generar_reporte_pdf(df, ruta_pdf)
