import requests
import zipfile
import pandas as pd
import os
import shutil

def download_and_process_zip(url):

    # Nombre del archivo ZIP local
    zip_filename = url.split("/")[-1]  # Extrae el nombre del archivo de la URL

    # Descargar el archivo ZIP
    print("Descargando el archivo...")
    response = requests.get(url)
    if response.status_code == 200:
        with open(zip_filename, "wb") as file:
            file.write(response.content)
        print(f"Archivo descargado: {zip_filename}")
    else:
        print(f"Error al descargar el archivo. Código de estado: {response.status_code}")
        return None

    # Descomprimir el archivo ZIP
    print("Descomprimiendo el archivo...")
    extracted_folder = "extracted_files"
    os.makedirs(extracted_folder, exist_ok=True)

    try:
        with zipfile.ZipFile(zip_filename, 'r') as zip_ref:
            zip_ref.extractall(extracted_folder)
            print(f"Archivos extraídos en la carpeta: {extracted_folder}")
        # Buscar el archivo CSV dentro de la carpeta descomprimida
        csv_file = None
        for root, dirs, files in os.walk(extracted_folder):
            for file in files:
                if file.endswith(".csv"):
                    csv_file = os.path.join(root, file)
                    break
            if csv_file:
                break

        if csv_file:
            print(f"Archivo CSV encontrado: {csv_file}")
            
            # Leer el archivo CSV y convertirlo en un DataFrame de Pandas
            df = pd.read_csv(csv_file)
            print("DataFrame creado:")
            #print(df.head())  # Mostrar las primeras filas del DataFrame

            # Eliminar el archivo ZIP descargado
            print("Eliminando el archivo ZIP...")
            os.remove(zip_filename)
            print(f"Archivo ZIP eliminado: {zip_filename}")

            # Eliminar la carpeta descomprimida y su contenido
            print("Eliminando la carpeta descomprimida...")
            shutil.rmtree(extracted_folder)
            print(f"Carpeta eliminada: {extracted_folder}")

            return df  # Retornar el DataFrame
        else:
            print("No se encontró ningún archivo CSV en el ZIP.")
            return None

    except zipfile.BadZipFile:
        print(f"⚠️ Archivo inválido (no es ZIP): {zip_filename}")
        return None
        

    