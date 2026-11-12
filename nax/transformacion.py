import pandas as pd
import os

# Nombre real de la columna que identifica el tablon (respaldo) y la PIEZA (clave
# preferida, mas fina - un tablon puede tener varias piezas). Si en algun momento
# NAX cambia alguno de estos nombres, solo hay que ajustarlo aqui.
COLUMNA_TABLON = "grouping_unit_04"
COLUMNA_PIEZA_NAME = "name"  # identificador unico de PIEZA (admin+division+distrito+tablon+pieza)


def _columna_clave(df):
    """Detecta la columna que se debe usar como clave de analisis: preferentemente
    'name' (identifica cada PIEZA individualmente, mas fino que el tablon), y si no
    esta disponible, se cae a 'grouping_unit_04' (tablon) o 'lot_id' como respaldo.
    Usar 'name' evita perder piezas al combinar productos (antes, con 'grouping_unit_04'
    como clave, si un tablon tenia varias piezas con lecturas distintas el mismo dia,
    'aggfunc=first' se quedaba con los datos de UNA sola pieza y descartaba el resto)."""
    if COLUMNA_PIEZA_NAME in df.columns:
        return COLUMNA_PIEZA_NAME
    if COLUMNA_TABLON in df.columns:
        return COLUMNA_TABLON
    if "lot_id" in df.columns:
        return "lot_id"
    raise KeyError(
        f"No se encontro ni '{COLUMNA_PIEZA_NAME}', ni '{COLUMNA_TABLON}', ni 'lot_id' en "
        "los datos descargados. Revisa las columnas del CSV que devuelve NAX (puede que "
        "el nombre haya cambiado)."
    )


def reorganize_data(df):

    col_clave = _columna_clave(df)

    # Pivotar el DataFrame para reorganizar los datos de 'mean'. Al usar 'name' (PIEZA)
    # como clave en vez del tablon, cada pieza conserva sus propias lecturas de cada
    # producto, sin mezclarse con las de otras piezas del mismo tablon.
    df_pivot_mean = df.pivot_table(index=['timestamp', col_clave], columns='product_name', values='mean', aggfunc='first').reset_index()

    # Renombrar las columnas para que sean más claras
    df_pivot_mean.columns.name = None  # Eliminar el nombre de las columnas (product_name)

    # Si una columna CRUDA del lote (ej. el atributo 'tsh' de fin de zafra) tiene el
    # MISMO nombre que una columna recien pivotada (ej. el producto satelital 'tsh'
    # que se pide por separado), pd.merge las renombraria a 'tsh_x'/'tsh_y' para no
    # chocar - eso parte el dato en dos columnas y rompe cualquier busqueda por
    # nombre exacto mas adelante. Se evita quitando del lado crudo cualquier columna
    # que ya viene pivotada (el valor satelital, mas especifico, es el que se
    # conserva sin sufijo).
    columnas_en_conflicto = (set(df.columns) & set(df_pivot_mean.columns)) - {'timestamp', col_clave}
    if columnas_en_conflicto:
        df = df.drop(columns=list(columnas_en_conflicto))

    df_final = pd.merge(df, df_pivot_mean, on=['timestamp', col_clave], how='left')

    # Eliminar duplicados (ya que el merge puede crear filas duplicadas)
    df_final['timestamp'] = pd.to_datetime(df_final['timestamp'])
    df_final = df_final.drop_duplicates(subset=['timestamp', col_clave])

    ###########
    ''' incluir limpieza de datos'''

    return df_final

def agregar_a_historico(df_reorganizado, ruta_historico):
    """Agrega UN dataframe reorganizado al historico, reescribiendo el CSV completo.
    Se mantiene por compatibilidad, pero para agregar varias fechas de una vez usa
    agregar_multiples_a_historico (mucho mas rapido con miles de piezas, porque
    escribe el archivo una sola vez en vez de una vez por fecha)."""
    return agregar_multiples_a_historico([df_reorganizado], ruta_historico)


def agregar_multiples_a_historico(lista_df_reorganizados, ruta_historico):
    """
    Igual que agregar_a_historico, pero recibe una LISTA de dataframes (uno por fecha
    descargada) y escribe el CSV historico UNA SOLA VEZ al final. Con miles de piezas
    y varias fechas, hacer un merge+escritura por cada fecha es muy lento (reescribe
    el archivo completo cada vez); esta version junta todo en memoria primero.
    """
    if not lista_df_reorganizados:
        return None

    col_clave = _columna_clave(lista_df_reorganizados[0])

    # Leer el archivo histórico si existe
    if os.path.exists(ruta_historico):
        df_historico = pd.read_csv(ruta_historico)
        piezas_antes = set(df_historico[col_clave].astype(str)) if col_clave in df_historico.columns else set()
    else:
        df_historico = pd.DataFrame()
        piezas_antes = set()

    # Concatenar el histórico existente con TODAS las piezas nuevas de una vez
    df_historico_actualizado = pd.concat([df_historico] + lista_df_reorganizados, ignore_index=True)

    df_historico_actualizado['timestamp'] = pd.to_datetime(df_historico_actualizado['timestamp'])
    df_historico_actualizado = df_historico_actualizado.sort_values(by='timestamp', ascending=False)

    # Eliminar duplicados basados en 'fecha imagen' (timestamp) e ID de la pieza
    df_historico_actualizado = df_historico_actualizado.drop_duplicates(subset=['timestamp', col_clave])

    piezas_despues = set(df_historico_actualizado[col_clave].astype(str))
    piezas_nuevas = piezas_despues - piezas_antes
    print(f"Piezas que ya estaban en el histórico antes de esta descarga: {len(piezas_antes)}")
    print(f"Piezas NUEVAS agregadas en esta descarga: {len(piezas_nuevas)}")
    print(f"Total de piezas en el histórico después de esta descarga: {len(piezas_despues)}")

    # Guardar el DataFrame actualizado en el archivo histórico
    df_historico_actualizado.to_csv(ruta_historico, index=False)

    return df_historico_actualizado
