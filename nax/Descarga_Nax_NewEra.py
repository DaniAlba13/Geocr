import os
import requests
import json
import time
import re
import tkinter as tk
from tkinter import messagebox, ttk, filedialog
from tkcalendar import DateEntry
from procesamiento import download_and_process_zip
from transformacion import reorganize_data, agregar_a_historico, agregar_multiples_a_historico
from reporte import generar_reporte_desde_csv
from datetime import datetime, timedelta
import pandas as pd
import os

'''
***********************************************************************************************************
IMPORTANTE: Cambiar usuario y contraseña en la fila 21 y 22, FILA 26 PARA EL AREA luego guardar el archivo
LISTA DE PRODUCTOS: Cambiar en fila 170 (variable 'productos_confirmados')
UMBRALES DEL REPORTE PDF DE DECISIÓN (madurantes/cosecha): ver archivo reporte.py, diccionario RANGOS.
Si cambias la lista de productos de abajo, revisa también reporte.py para que las métricas coincidan.
***********************************************************************************************************
'''


email_user = os.environ.get("NAX_EMAIL", "")  # nunca escribas la contraseña aquí: va en los Secrets de GitHub
password_user = os.environ.get("NAX_PASSWORD", "")

# CAMBIAR PARA ELEGIR EL AREA DEL CLIENTE (solo se usa si ANALIZAR_TODAS_LAS_AREAS = False)
area_base = 207

# Si True, la descarga incluye TODAS las áreas de la cuenta (todos los campos/tablones,
# ~20,000 en el caso de Central Romana). Si False, solo descarga el área indicada en
# 'area_base' arriba (útil para pruebas rápidas con pocos tablones, sin esperar una
# descarga completa de toda la operación).
ANALIZAR_TODAS_LAS_AREAS = True

# Si True, la descarga incluye TODAS las campañas/zafras disponibles (no solo la
# seleccionada en el desplegable "Campaign"). OJO: las campañas representan la MISMA
# tierra en distintas zafras/años (no un subconjunto distinto de tablones), así que
# normalmente NO hace falta esto para el análisis de los modelos (NDVI, Humedad,
# Biomasa) - con la campaña actual ya se tienen todos los tablones activos. Se deja
# en False por defecto para que la descarga sea rápida. La única excepción es el
# análisis de TCA (comparar cañas de cierta edad de la zafra actual vs la anterior),
# que sí necesita datos de más de una campaña - eso se maneja aparte, no con este flag.
ANALIZAR_TODAS_LAS_CAMPANAS = False


'''
***********************************************************************************************************
'''

# Variables globales
headers = None
company_id = None
areas = None
tupla_campa = None
start_date = None
end_date = None
base_var = None
campaign_combobox = None
save_path = None
report_button = None
ids_campana_por_nombre = {}  # nombre de campaña -> [ids en cada área]



def login(email, password):
    url = "https://beta-api.naxsolutions.com/api/v1/token/pair"
    payload = {
        "email": email,
        "password": password
    }
    response = requests.post(url, json=payload)
    if response.status_code == 200:
        token = response.json()['access']
        headers = {'Authorization': f'Bearer {token}'}
        return headers
    else:
        messagebox.showerror("Error", "Login failed")
        return None



def get_user_data(headers):
    me_url = "https://beta-api.naxsolutions.com/api/v1/users/me"
    response_me = requests.get(me_url, headers=headers)
    if response_me.status_code == 200:
        me = response_me.json()
        corpo = me['corporate_id']
        compa_url = f"https://beta-api.naxsolutions.com/api/v1/corporates/{corpo}/companies"
        response_corpo = requests.get(compa_url, headers=headers)
        if response_corpo.status_code == 200:
            compa = response_corpo.json()
            #print(compa)
            compani = compa[0]['id']
            area_url = f"https://beta-api.naxsolutions.com/api/v1/companies/{compani}/areas"
            response_area = requests.get(area_url, headers=headers)
            if response_area.status_code == 200:
                are = response_area.json()
                lista_area = [item['id'] for item in are['items']]
                print("Áreas disponibles para esta cuenta:", lista_area)
                if area_base not in lista_area:
                    print(f"⚠ AVISO: area_base={area_base} no está en la lista de áreas de arriba. "
                          f"Cambia la variable 'area_base' al inicio del archivo por uno de esos números.")
                if ANALIZAR_TODAS_LAS_AREAS:
                    print(f"ANALIZAR_TODAS_LAS_AREAS=True -> se usarán las {len(lista_area)} áreas de la cuenta")
                else:
                    lista_area = [area_base]
                    print(f"ANALIZAR_TODAS_LAS_AREAS=False -> se usará solo el área {area_base}")
                tupla_campa = []
                for area in lista_area:
                    campa_url = f"https://beta-api.naxsolutions.com/api/v1/areas/{area}/campaigns"
                    response_campa = requests.get(campa_url, headers=headers)
                    if response_campa.status_code == 200:
                        campa = response_campa.json()
                        #print(campa)
                        tupla_campa.extend([(item['id'], item['name']) for item in campa['items']])
                #print(tupla_campa)
                # La misma campaña (ej. "Zafra 2026") suele repetirse en muchas áreas;
                # quitar duplicados por nombre para que el combobox no muestre repetidos.
                vistos = set()
                tupla_campa_unica = []
                # La misma campaña tiene un id DISTINTO en cada área; se guardan todos
                # para poder traer el listado maestro completo de lotes (todas las áreas).
                ids_campana_por_nombre.clear()
                for id_campa, nombre in tupla_campa:
                    ids_campana_por_nombre.setdefault(nombre, []).append(id_campa)
                    if nombre not in vistos:
                        vistos.add(nombre)
                        tupla_campa_unica.append((id_campa, nombre))
                return compani, lista_area, tupla_campa_unica
    messagebox.showerror("Error", "Failed to fetch user data")
    return None, None, None

# Función para descargar los productos
def download_products():
    global company_id, areas, campaign_combobox, start_date, end_date, base_var, save_path, tupla_campa
    
    compani = company_id
    lista_area = areas
    campana_name = campaign_combobox.get()

    if ANALIZAR_TODAS_LAS_CAMPANAS:
        nombres_campana = sorted(set(nombre for _, nombre in tupla_campa)) if tupla_campa else [campana_name]
        print(f"ANALIZAR_TODAS_LAS_CAMPANAS=True -> se usarán las {len(nombres_campana)} campañas: {nombres_campana}")
    else:
        nombres_campana = [campana_name]
        print(f"ANALIZAR_TODAS_LAS_CAMPANAS=False -> se usará solo la campaña '{campana_name}'")

    start = start_date.get_date().strftime("%Y-%m-%d")
    end = end_date.get_date().strftime("%Y-%m-%d")
  
    start_dt =  start_date.get_date()
    end_dt = end_date.get_date()

    if start_dt > end_dt:
        messagebox.showerror("Error", "La fecha final debe ser mayor o igual a la fecha de inicio.")
        return 
    elif start_dt == end_dt:
        # Sumar un día a end
        end_dt += timedelta(days=1)
        end_dt = end_dt.strftime("%Y-%m-%d")
        
    base = base_var.get()
    
    #productos_list = ["chlorophyll_content", "ripening_level_2", "sugarcane_humidity_level2", "water_content_evolution"]
    #productos_list = ["water_content_level_2", "water_content", "ndwi", "available_water"]
    #productos_list = ["ripening_level_2", "optimal_chlorophyll", "optimal_lai", "optimal_ndvi", "optimal_water_content", "production", "anomalies", "nni"]
    #productos_list = ["lai_20m", "lai_level_2_20m", "median_optimal_lai", "median_optimal_ndvi", "median_optimal_chlorophyll", "ripening_level_2", "median_optimal_water", "optimal_chlorophyll", "optimal_lai", "optimal_water_content"]
    # Estos son los productos YA CONFIRMADOS que funcionan, según la lista OFICIAL de
    # productos del manual de la API de NAX (Anexo III). IMPORTANTE: cada producto se
    # pide en su PROPIA solicitud (ver el bucle más abajo), nunca mezclados en una
    # sola lista - ya nos pasó que un solo código inválido en una solicitud combinada
    # ("Producto no existente") tumba TODA la solicitud, incluso para los productos
    # que sí son válidos.
    # "yield_sugarcane" es el candidato oficial para TCH (aparece tal cual en el
    # Anexo III) - "tch" y "tsh" NO existen en esa lista, por eso fallaban.
    # Humedad: "sugarcane_humidity_level2" y "moisture_distribution_high_frequency"
    # NO existen en la lista real de productos de la API (confirmado consultando
    # GET /campaigns/{id}/products para la campaña 2026 - ver el diagnostico que
    # imprime obtener_model_ids_campana cuando un producto no se encuentra). El
    # nombre correcto es "sugarcane_humidity" (existe tambien "sugarcane_humidity_
    # noclouds", version filtrada de nubes) - se piden los dos, cada uno por su
    # cuenta, sin riesgo porque el que no exista en una campaña se omite solo.
    productos_confirmados = ["ndvi", "sugarcane_humidity", "sugarcane_humidity_noclouds",
                              "yield_sugarcane"]

    # Biomasa: "biomass" NO aparece en ningún lado de la lista oficial (Anexo III),
    # por eso daba "Producto no existente". Los candidatos más probables para
    # "Área Foliar" son "lai_20m" y "lai_level_2_20m" (LAI = Leaf Area Index = Índice
    # de Área Foliar), que sí están en la lista oficial. Como ahora cada producto se
    # pide por separado, no hay riesgo en probar los dos a la vez: revisa la
    # terminal, ahí va a decir "IMAGEN DISPONIBLE" o "PRODUCTO INVÁLIDO" para cada
    # uno por separado. reporte.py ya busca automáticamente cualquier columna
    # relacionada a "lai"/"biomass" en el histórico y te dice el nombre exacto.
    productos_confirmados.append("lai_20m")
    productos_confirmados.append("lai_level_2_20m")

    # Anomalias: "anomalies" SÍ está confirmado en la lista oficial (Anexo III).
    productos_confirmados.append("anomalies")

    
    
    # La API ya no acepta "products" (nombres) en /geoserver/downloads - ahora exige
    # "model_ids" (IDs numéricos), que dependen de la campaña y se consultan vía
    # GET /campaigns/{campaign_id}/products. Se resuelve UNA vez por campaña (no en
    # cada fecha) - se usa el primer campaign_id visto para esa campaña, asumiendo
    # que los modelos disponibles son los mismos en todas las áreas de la campaña.
    model_ids_por_campana = {}
    for nombre_campana_actual in nombres_campana:
        ids_de_esta_campana = ids_campana_por_nombre.get(nombre_campana_actual, [])
        if not ids_de_esta_campana:
            print(f"⚠ No se encontró el campaign_id de '{nombre_campana_actual}' - no se podrán "
                  "resolver sus model_ids.")
            model_ids_por_campana[nombre_campana_actual] = {}
            continue
        model_ids_por_campana[nombre_campana_actual] = obtener_model_ids_campana(
            ids_de_esta_campana[0], productos_confirmados)

    start_dt =  start_date.get_date()
    end_dt = end_date.get_date()
    download_ids = []
    intentos_totales = 0
    sin_fecha_procesada = 0  # cuenta los NO_DATES_TO_DOWNLOAD, para el mensaje final
    # Primera iteración: crear solicitudes de descarga - una por cada fecha x
    # campaña x PRODUCTO (cada producto en su propia solicitud, para que un código
    # invalido nunca tumbe a los demás).
    current_date = start_dt
    for current_date in pd.date_range(start=start_dt, end=end_dt):

        fecha_str = current_date.strftime("%Y-%m-%d")

        for nombre_campana_actual in nombres_campana:
            for producto in productos_confirmados:
                model_id = model_ids_por_campana.get(nombre_campana_actual, {}).get(producto)
                if model_id is None:
                    continue  # ya se avisó en obtener_model_ids_campana() que este producto no existe aquí

                payload = {
                    "company_id": compani,
                    "base": base,
                    "model_ids": [model_id],
                    "areas": lista_area,
                    "campaign_name": nombre_campana_actual,
                    "start_date": fecha_str,
                    "end_date": fecha_str
                }

                response_products = requests.request(
                    method="POST",
                    url="https://beta-api.naxsolutions.com/api/v1/geoserver/downloads",
                    headers=headers,
                    data=json.dumps(payload)
                )
                intentos_totales += 1

                if response_products.status_code == 200:
                    productos = response_products.json()
                    descarga_id = productos['id']
                    download_ids.append(descarga_id)
                    print(f"IMAGEN DISPONIBLE ({producto}): {current_date} - campaña '{nombre_campana_actual}'")
                elif response_products.status_code in (401, 403):
                    print(f"SESIÓN VENCIDA (código {response_products.status_code}) en fecha {fecha_str} - "
                          "cierra el programa y vuelve a iniciar sesión (Login).")
                    print(f"Respuesta de NAX: {response_products.text[:300]}")
                elif response_products.status_code == 400 and "NO_DATES_TO_DOWNLOAD" in response_products.text:
                    # No es un problema del codigo del producto - simplemente no hay
                    # imagen satelital procesada para esa fecha todavia (muy comun con
                    # fechas muy recientes, el satelite suele tardar 1-3 dias en
                    # procesarse).
                    sin_fecha_procesada += 1
                    print(f"SIN IMAGEN AÚN ({producto}): {fecha_str} - NAX no tiene fecha procesada "
                          "para descargar todavía (normal en fechas muy recientes).")
                elif response_products.status_code == 400:
                    print(f"PRODUCTO INVÁLIDO ({producto}): revisa ese código en 'productos_confirmados' "
                          f"- {response_products.text[:200]}")
                else:
                    print(f"SIN IMAGEN ({producto}): {fecha_str} - campaña '{nombre_campana_actual}' "
                          f"(código {response_products.status_code}: {response_products.text[:150]})")

    time.sleep(0)
    print("Datos id: ")
    print(download_ids)

    if not download_ids:
        if intentos_totales > 0 and sin_fecha_procesada == intentos_totales:
            messagebox.showerror(
                "Sin imágenes disponibles todavía",
                "NAX todavía no tiene procesada ninguna imagen para el rango de fechas "
                "seleccionado (NO_DATES_TO_DOWNLOAD en todos los intentos).\n\n"
                "Esto es normal con fechas muy recientes (el satélite suele tardar 1-3 días "
                "en procesarse) - no es un problema de los productos configurados.\n\n"
                "Prueba con un rango de fechas un poco más viejo (ej. hace 5-7 días)."
            )
        else:
            messagebox.showerror(
                "Sin imágenes disponibles",
                "NAX no devolvió ninguna imagen para ninguna fecha del rango seleccionado.\n\n"
                "Esto puede pasar si:\n"
                "- Alguno de los productos en 'productos_confirmados' no tiene model_id en esta campaña "
                "(revisa la terminal, ahí debería decir qué producto se omitió)\n"
                "- No hay imágenes satelitales para esas fechas/área todavía\n\n"
                "Revisa 'productos_confirmados' en este archivo y vuelve a intentar."
            )
        return

    piezas_historico = _esperar_y_descargar(download_ids, compani)

    # Escribir el histórico UNA SOLA VEZ al final (en vez de reescribir el CSV completo
    # en cada fecha), que con miles de tablones es mucho más rápido.
    if piezas_historico:
        agregar_multiples_a_historico(piezas_historico, save_path)
        print(f"Histórico actualizado con {len(piezas_historico)} fechas")
    else:
        print("No se obtuvo ningún dato para agregar al histórico")

    # Listado maestro de TODOS los lotes de la campaña (tengan o no imagen satelital en
    # el rango) - es lo que permite que el reporte cubra el 100% de los acres.
    descargar_maestro_lotes(campana_name, RUTA_MAESTRO_LOTES)

    report_button.config(state=tk.NORMAL)
    messagebox.showinfo("Éxito", f"Archivo guardado en {save_path}")


# Nombre fijo del archivo donde se guardan los datos de la campaña anterior - fijo
# (no se pregunta con "Guardar como") para que reporte.py lo pueda encontrar solo,
# sin tener que configurar una ruta. Antes solo traia TCH ('historico_tch_campana_
# anterior.csv'); ahora trae TODOS los productos confirmados (NDVI, Humedad,
# Biomasa y TCH), para que el reporte pueda comparar historico vs. zafra actual en
# cada apartado, no solo en TCA.
RUTA_HISTORICO_CAMPANA_ANTERIOR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                "historico_campana_anterior.csv")

# Listado maestro de lotes (todos los campos de la campaña, con su área efectiva,
# fecha de inicio, riego, variedad y TCH estimado), sin depender de que hayan tenido
# imagen satelital. reporte.py lo usa para completar los campos sin lectura.
_DIR_SCRIPT = os.path.dirname(os.path.abspath(__file__))
RUTA_MAESTRO_LOTES = os.path.join(_DIR_SCRIPT, "maestro_lotes.csv")
RUTA_MAESTRO_LOTES_ANTERIOR = os.path.join(_DIR_SCRIPT, "maestro_lotes_campana_anterior.csv")


def _obtener_todos_los_items(url, params_base=None, max_paginas=500):
    """GET paginado y defensivo: acepta respuestas tipo lista o tipo {'items', 'count'},
    y pide páginas con limit/offset hasta completar 'count'. Si el endpoint ignora la
    paginación, igual termina (no se queda en un ciclo infinito)."""
    items = []
    offset = 0
    limite = 1000
    for _ in range(max_paginas):
        params = dict(params_base or {})
        params.update({"limit": limite, "offset": offset})
        respuesta = requests.get(url, headers=headers, params=params)
        if respuesta.status_code != 200:
            print(f"⚠ No se pudo leer {url} (código {respuesta.status_code}): {respuesta.text[:200]}")
            break
        data = respuesta.json()
        if isinstance(data, list):
            items.extend(data)
            break
        lote = data.get("items", [])
        items.extend(lote)
        total = data.get("count")
        if not lote or total is None or len(items) >= total:
            break
        offset += len(lote)
    return items


# Cache simple en memoria: {id_campana: {nombre_producto: model_id}} - evita volver a
# consultar GET /campaigns/{id}/products para la misma campaña una y otra vez dentro
# de la misma corrida (se pide uno por fecha x producto, sería un desperdicio).
_cache_model_ids = {}


def obtener_model_ids_campana(id_campana, nombres_productos):
    """Traduce nombres de producto (ej. 'ndvi') a sus model_ids NUMÉRICOS reales para
    ESTA campaña, vía GET /campaigns/{campaign_id}/products (devuelve un objeto
    indexado por nombre de producto, cada uno con su 'id'). Los IDs dependen de la
    campaña - no se deben fijar a mano. Devuelve {nombre: id}; un nombre que no
    exista en esta campaña simplemente no aparece en el resultado (se avisa una vez)."""
    if id_campana in _cache_model_ids:
        disponibles = _cache_model_ids[id_campana]
    else:
        url = f"https://beta-api.naxsolutions.com/api/v1/campaigns/{id_campana}/products"
        try:
            respuesta = requests.get(url, headers=headers)
        except Exception as e:
            print(f"⚠ Error consultando productos/modelos de la campaña (id {id_campana}): {e}")
            return {}
        if respuesta.status_code != 200:
            print(f"⚠ No se pudieron obtener los productos/modelos de la campaña (id {id_campana}): "
                  f"código {respuesta.status_code}: {respuesta.text[:200]}")
            return {}
        disponibles = respuesta.json()
        _cache_model_ids[id_campana] = disponibles

    resultado = {}
    faltantes = []
    for nombre in nombres_productos:
        info = disponibles.get(nombre) if isinstance(disponibles, dict) else None
        if isinstance(info, dict) and "id" in info:
            resultado[nombre] = info["id"]
        else:
            faltantes.append(nombre)
    if faltantes:
        for nombre in faltantes:
            print(f"⚠ El producto '{nombre}' no está disponible en esta campaña (campaign_id "
                  f"{id_campana}) - no tiene model_id, se omite.")
        # Para no seguir adivinando nombres de producto a ciegas: si alguno no se
        # encontró, se imprime la lista COMPLETA de lo que SÍ devuelve la API para
        # esta campaña, para poder leer ahí el nombre exacto (puede no coincidir con
        # lo que se ve en el panel web de NAX).
        if isinstance(disponibles, dict):
            print(f"   Productos que SÍ devuelve la API para esta campaña (campaign_id "
                  f"{id_campana}): {sorted(disponibles.keys())}")
    return resultado


def _esperar_y_descargar(download_ids, compani, max_segundos_espera=600):
    """Espera a que las descargas de 'download_ids' queden listas (campo 'location'
    distinto de None) y descarga cada ZIP ya procesado como DataFrame reorganizado.
    Usa GET /geoserver/downloads PAGINADO (por defecto solo trae las 100 más
    recientes - con muchas descargas hace falta recorrer todas las páginas para
    encontrarlas). Tiene un tope de espera para no quedarse colgado para siempre."""
    pendientes = set(download_ids)
    ubicaciones = {}
    inicio = time.time()
    while pendientes and (time.time() - inicio) < max_segundos_espera:
        items = _obtener_todos_los_items(
            "https://beta-api.naxsolutions.com/api/v1/geoserver/downloads",
            params_base={"company_id": compani})
        por_id = {item.get("id"): item for item in items}
        for id_ in list(pendientes):
            item = por_id.get(id_)
            if item and item.get("location"):
                ubicaciones[id_] = item["location"]
                pendientes.discard(id_)
        if pendientes:
            time.sleep(2)

    if pendientes:
        print(f"⚠ {len(pendientes)} descarga(s) no quedaron listas dentro del tiempo de espera "
              f"({max_segundos_espera}s) - se continúa solo con las que sí están listas.")

    piezas_historico = []
    for id_, location in ubicaciones.items():
        df = download_and_process_zip(location)
        if df is not None:
            print(f"DataFrame obtenido: {id_}")
            piezas_historico.append(reorganize_data(df))
        else:
            print(f"Dataframe vacío: {id_}")
    return piezas_historico


def descargar_maestro_lotes(nombre_campana, ruta_salida):
    """Descarga TODOS los lotes de una campaña (en todas las áreas donde exista) desde
    GET /api/v1/campaigns/{campaign_id}/lots y los guarda en un CSV. Si falla, solo
    avisa en la terminal - nunca interrumpe la descarga principal."""
    try:
        ids = ids_campana_por_nombre.get(nombre_campana, [])
        if not ids:
            print(f"⚠ No se encontraron ids para la campaña '{nombre_campana}' - no se descargó el maestro de lotes.")
            return None
        todos = []
        for id_campana in ids:
            url = f"https://beta-api.naxsolutions.com/api/v1/campaigns/{id_campana}/lots"
            todos.extend(_obtener_todos_los_items(url))
        if not todos:
            print(f"⚠ El maestro de lotes de '{nombre_campana}' vino vacío.")
            return None
        df = pd.DataFrame(todos)
        # quitar columnas anidadas (dict/list) que no caben en un CSV plano
        columnas_planas = [c for c in df.columns
                           if not df[c].apply(lambda v: isinstance(v, (dict, list))).any()]
        df = df[columnas_planas]
        if "id" in df.columns:
            df = df.drop_duplicates(subset=["id"])
        df.to_csv(ruta_salida, index=False)
        area_total = pd.to_numeric(df.get("effective_area"), errors="coerce").sum() if "effective_area" in df.columns else None
        print(f"Maestro de lotes '{nombre_campana}': {len(df)} lotes guardados en {ruta_salida}"
              + (f" ({area_total:,.0f} acres de área efectiva)" if area_total else ""))
        print(f"Columnas del maestro de lotes: {list(df.columns)}")
        return ruta_salida
    except Exception as e:
        print(f"⚠ Error descargando el maestro de lotes: {e}")
        return None


def _parsear_fecha_campana(nombre_campana):
    """Extrae una fecha aproximada (dia 1 del mes) del nombre de una campaña, ej.
    '12/2026 (SUGARCANE)' -> date(2026, 12, 1). Devuelve None si no se puede parsear
    (formato de nombre distinto al esperado)."""
    m = re.match(r"\s*(\d{1,2})/(\d{4})", nombre_campana)
    if not m:
        return None
    mes, anio = int(m.group(1)), int(m.group(2))
    try:
        return datetime(anio, mes, 1).date()
    except ValueError:
        return None


def _obtener_campana_anterior(nombre_campana_actual, tupla_campanas):
    """Encuentra la campaña INMEDIATAMENTE ANTERIOR por fecha a la actual, entre
    todas las campañas disponibles en tupla_campanas. Devuelve el nombre de esa
    campaña, o None si no se pudo determinar (ej. no hay ninguna anterior, o el
    nombre no sigue el formato 'MM/AAAA...')."""
    fecha_actual = _parsear_fecha_campana(nombre_campana_actual)
    if fecha_actual is None:
        return None
    candidatas = []
    for _, nombre in tupla_campanas:
        fecha = _parsear_fecha_campana(nombre)
        if fecha is not None and fecha < fecha_actual:
            candidatas.append((fecha, nombre))
    if not candidatas:
        return None
    candidatas.sort(key=lambda x: x[0])
    return candidatas[-1][1]  # la mas reciente de las anteriores a la actual


# Función para descargar los datos de la campaña anterior (NDVI, Humedad, Biomasa
# y TCH - los MISMOS productos que la campaña actual). Es una descarga APARTE de la
# principal, de una campaña distinta, y es la que permite que el reporte compare
# "historico vs. zafra actual" en cada apartado (Humedad, NDVI, Biomasa y TCA), no
# solo en TCA como antes.
def download_datos_campana_anterior():
    global company_id, areas, campaign_combobox, start_date, end_date, base_var, tupla_campa

    campana_actual = campaign_combobox.get()
    campana_anterior = _obtener_campana_anterior(campana_actual, tupla_campa)
    if campana_anterior is None:
        messagebox.showerror(
            "Sin campaña anterior",
            f"No se pudo determinar la campaña anterior a '{campana_actual}'. Revisa que "
            "el desplegable 'Campaign' tenga más de una campaña, y que los nombres sigan "
            "el formato 'MM/AAAA (...)' (ej. '12/2025 (SUGARCANE)')."
        )
        return

    fecha_actual_campana = _parsear_fecha_campana(campana_actual)
    fecha_anterior_campana = _parsear_fecha_campana(campana_anterior)
    desplazamiento_dias = (fecha_anterior_campana - fecha_actual_campana).days

    start_dt = start_date.get_date() + timedelta(days=desplazamiento_dias)
    end_dt = end_date.get_date() + timedelta(days=desplazamiento_dias)

    print(f"Campaña actual: '{campana_actual}' | Campaña anterior detectada: '{campana_anterior}'")
    print(f"Descargando datos de '{campana_anterior}' para el período equivalente: {start_dt} a {end_dt}")

    compani = company_id
    lista_area = areas
    base = base_var.get()
    # Mismos productos CONFIRMADOS que se piden para la campaña actual (sin
    # "anomalies", que no se usa en ninguna comparacion historico vs. actual) -
    # asi se puede comparar Humedad/NDVI/Biomasa/TCA, no solo TCH como antes.
    productos_anterior = ["ndvi", "sugarcane_humidity", "sugarcane_humidity_noclouds",
                           "yield_sugarcane", "lai_20m", "lai_level_2_20m"]

    ids_campana_anterior = ids_campana_por_nombre.get(campana_anterior, [])
    if not ids_campana_anterior:
        messagebox.showerror(
            "Sin campaign_id",
            f"No se encontró el campaign_id de la campaña '{campana_anterior}' - revisa la "
            "terminal (lista de campañas disponibles)."
        )
        return
    model_ids_anterior = obtener_model_ids_campana(ids_campana_anterior[0], productos_anterior)

    download_ids = []
    intentos_totales = 0
    sin_fecha_procesada = 0
    # Igual que en download_products(): cada producto se pide en su PROPIA solicitud,
    # para que un código inválido/no disponible en esta campaña nunca tumbe a los demás.
    for current_date in pd.date_range(start=start_dt, end=end_dt):
        fecha_str = current_date.strftime("%Y-%m-%d")
        for producto in productos_anterior:
            model_id = model_ids_anterior.get(producto)
            if model_id is None:
                continue  # ya se avisó en obtener_model_ids_campana() que este producto no existe aquí

            payload = {
                "company_id": compani,
                "base": base,
                "model_ids": [model_id],
                "areas": lista_area,
                "campaign_name": campana_anterior,
                "start_date": fecha_str,
                "end_date": fecha_str
            }
            response_products = requests.request(
                method="POST",
                url="https://beta-api.naxsolutions.com/api/v1/geoserver/downloads",
                headers=headers,
                data=json.dumps(payload)
            )
            intentos_totales += 1

            if response_products.status_code == 200:
                productos_resp = response_products.json()
                download_ids.append(productos_resp['id'])
                print(f"IMAGEN DISPONIBLE (campaña anterior, {producto}): {current_date}")
            elif response_products.status_code in (401, 403):
                print(f"SESIÓN VENCIDA (código {response_products.status_code}) en fecha {fecha_str} - "
                      "cierra el programa y vuelve a iniciar sesión (Login).")
            elif response_products.status_code == 400 and "NO_DATES_TO_DOWNLOAD" in response_products.text:
                sin_fecha_procesada += 1
                print(f"SIN IMAGEN AÚN (campaña anterior, {producto}): {fecha_str} - NAX no tiene fecha "
                      "procesada para descargar todavía.")
            elif response_products.status_code == 400:
                print(f"PRODUCTO INVÁLIDO (campaña anterior, {producto}): "
                      f"{response_products.text[:200]}")
            else:
                print(f"SIN IMAGEN (campaña anterior, {producto}): {fecha_str} "
                      f"(código {response_products.status_code}: {response_products.text[:150]})")

    if not download_ids:
        # Sin imágenes, pero el maestro de lotes (TCH estimado por lote) no depende de
        # imágenes - se intenta igual antes de rendirse.
        if descargar_maestro_lotes(campana_anterior, RUTA_MAESTRO_LOTES_ANTERIOR):
            messagebox.showinfo(
                "Datos de campaña anterior",
                f"No hubo imágenes satelitales de '{campana_anterior}' en el período equivalente, "
                "pero sí se descargó el listado de lotes con su TCH estimado (el reporte usará ese "
                "dato para la comparación de TCA). Las comparaciones de Humedad/NDVI/Biomasa no "
                "tendrán datos de la campaña anterior hasta que haya imágenes disponibles para ese "
                "período."
            )
        else:
            messagebox.showerror(
                "Sin datos disponibles",
                f"NAX no devolvió imágenes ni el listado de lotes para la campaña '{campana_anterior}'. "
                "Revisa la terminal para ver el detalle."
            )
        return

    piezas_historico = _esperar_y_descargar(download_ids, compani)

    if piezas_historico:
        agregar_multiples_a_historico(piezas_historico, RUTA_HISTORICO_CAMPANA_ANTERIOR)

    # Maestro de lotes de la campaña anterior: TCH estimado de TODOS sus campos, no
    # solo de los que tuvieron imagen en el período equivalente.
    ruta_maestro_ant = descargar_maestro_lotes(campana_anterior, RUTA_MAESTRO_LOTES_ANTERIOR)

    if piezas_historico or ruta_maestro_ant:
        messagebox.showinfo(
            "Éxito",
            f"Datos de la campaña anterior ('{campana_anterior}') guardados.\n\n"
            "Ya puedes generar el reporte y va a incluir las comparaciones de campaña anterior vs. "
            "actual en Humedad, NDVI, Biomasa y TCA."
        )
    else:
        messagebox.showerror("Error", "No se obtuvo ningún dato de la campaña anterior.")


# Función para generar el reporte PDF de alertas a partir del histórico ya descargado
def generar_reporte():
    global save_path
    if not save_path or not os.path.exists(save_path):
        messagebox.showerror("Error", "Primero descarga los datos o selecciona un histórico (.csv) existente con 'Guardar como'.")
        return
    try:
        ruta_pdf, ruta_excel = generar_reporte_desde_csv(save_path)
        messagebox.showinfo(
            "Reporte generado",
            f"Reporte PDF guardado en:\n{ruta_pdf}\n\n"
            f"Detalle de casos críticos (Excel) guardado en:\n{ruta_excel}"
        )
    except Exception as e:
        import traceback
        print("=" * 70)
        print("ERROR AL GENERAR EL REPORTE - traceback completo:")
        traceback.print_exc()
        print("=" * 70)
        messagebox.showerror("Error al generar el reporte", str(e))


# Función para seleccionar la ubicación del archivo
def select_file():
    global save_path, download_button, report_button
    save_path = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV files", "*.csv")])
    if save_path:
        download_button.config(state=tk.NORMAL)
        # Si ya existe un histórico en esa ruta, se puede generar el reporte sin volver a descargar
        if os.path.exists(save_path):
            report_button.config(state=tk.NORMAL)

# Función para centrar una ventana en la pantallas
def center_window(window, width, height):
    screen_width = window.winfo_screenwidth()
    screen_height = window.winfo_screenheight()
    x = (screen_width // 2) - (width // 2)
    y = (screen_height // 2) - (height // 2)
    window.geometry(f"{width}x{height}+{x}+{y}")


# Interfaz de Login
def create_login_window(email_user, password_user):
    def on_login():
        global headers, company_id, areas, tupla_campa
        # Usamos directamente los valores constantes
        headers = login(email_user, password_user)
        if headers:
            company_id, areas, tupla_campa = get_user_data(headers)
            if company_id:
                login_window.destroy()
                create_main_window()

    login_window = tk.Tk()
    login_window.title("Login")
    center_window(login_window, 300, 100)

    # Ya no pedimos email y password al usuario
    tk.Label(login_window, text="Autenticando con credenciales predeterminadas...").pack(pady=20)
    tk.Button(login_window, text="Login", command=on_login).pack(pady=10)

    login_window.mainloop()


# Interfaz principal
def create_main_window():
    global start_date, end_date, campaign_combobox, base_var, download_button, report_button
    
    main_window = tk.Tk()
    main_window.title("Nax Solutions API Client")
    center_window(main_window, 500, 390)
    
    # Fechas
    tk.Label(main_window, text="Start Date:").grid(row=0, column=0, padx=10, pady=10, sticky="e")
    start_date = DateEntry(main_window, date_pattern="yyyy-mm-dd")
    start_date.grid(row=0, column=1, padx=10, pady=10, sticky="w")
    
    tk.Label(main_window, text="End Date:").grid(row=1, column=0, padx=10, pady=10, sticky="e")
    end_date = DateEntry(main_window, date_pattern="yyyy-mm-dd")
    end_date.grid(row=1, column=1, padx=10, pady=10, sticky="w")
    
    # Radio Buttons para Base
    base_var = tk.StringVar(value="excel")  # Valor por defecto
    
    tk.Label(main_window, text="Base:").grid(row=2, column=0, padx=10, pady=10, sticky="e")
    
    excel_radio = tk.Radiobutton(main_window, text="Excel", variable=base_var, value="excel")
    excel_radio.grid(row=2, column=1, padx=10, pady=10, sticky="w")
        
    # Campaña
    tk.Label(main_window, text="Campaign:").grid(row=3, column=0, padx=10, pady=10, sticky="e")
    campaign_combobox = ttk.Combobox(main_window)
    campaign_combobox.grid(row=3, column=1, padx=10, pady=10, sticky="w")
    campaign_combobox['values'] = [alias for _, alias in tupla_campa]
    if tupla_campa:
        campaign_combobox.current(0)
    else:
        messagebox.showerror(
            "Sin campañas",
            "No se encontraron campañas para el área configurada (area_base).\n\n"
            "Revisa la pestaña TERMINAL: ahí se imprimió la lista de áreas disponibles "
            "para tu cuenta ('Áreas disponibles para esta cuenta: [...]'). Copia el número "
            "correcto, cierra el programa, colócalo en la variable 'area_base' al inicio de "
            "Descarga_Nax_NewEra.py, guarda el archivo y vuelve a ejecutarlo."
        )
    
    # Botón para seleccionar archivo
    tk.Button(main_window, text="Guardar como", command=select_file).grid(row=4, column=0, padx=10, pady=10, sticky="e")
    
    # Botón de Descarga (inicialmente desactivado)
    download_button = tk.Button(main_window, text="Descargar", command=download_products, state=tk.DISABLED)
    download_button.grid(row=4, column=1, padx=10, pady=10, sticky="w")

    # Botón para generar el reporte PDF de alertas (se habilita tras descargar o si ya existe un histórico)
    report_button = tk.Button(main_window, text="Generar Reporte PDF", command=generar_reporte, state=tk.DISABLED)
    report_button.grid(row=5, column=0, columnspan=2, padx=10, pady=10)

    # Botón para descargar los datos de la campaña anterior (NDVI, Humedad, Biomasa
    # y TCH - opcional, solo para las comparaciones "campaña anterior vs. actual"
    # del reporte). Se habilita ya desde el inicio porque no depende de "Guardar
    # como" ni de la descarga principal.
    datos_anterior_button = tk.Button(main_window, text="Descargar Datos Campaña Anterior",
                                       command=download_datos_campana_anterior)
    datos_anterior_button.grid(row=6, column=0, columnspan=2, padx=10, pady=10)
    
    main_window.mainloop()

if __name__ == "__main__":
    create_login_window(email_user,password_user)