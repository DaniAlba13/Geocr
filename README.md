# GeoCR · Agricultura de Precisión · Central Romana

Este repositorio publica la plataforma GeoCR en Cloudflare Pages. Además, contiene el robot que actualiza las Alertas NAX todos los días a las 6:00 a. m.

## Qué hay en cada carpeta

| Carpeta | Qué es |
|---|---|
| `public/` | La página que publica Cloudflare (`index.html`). No se edita a mano: se arma con `python build.py`. |
| `src/` | El código fuente de la página: los datos de capas y lluvias, el motor de Alertas NAX y los scripts embebidos. |
| `functions/api/` | La API que guarda los registros compartidos en la base de datos D1 de Cloudflare. |
| `nax/` | El robot de NAX: tus scripts (`Descarga_Nax_NewEra.py`, `procesamiento.py`, `transformacion.py`, `reporte.py`), más `nax_diario.py`, que los ejecuta sin ventanas, y `publicar.mjs`, que sube el resultado al tablero. |
| `.github/workflows/` | La programación diaria, a las 10:00 UTC (6:00 a. m. en RD). |

> La contraseña de NAX **no está en ningún archivo**. Se guarda en los secrets de GitHub.

---

## Configuración (se hace una sola vez)

### 1. Cloudflare Pages
1. En Cloudflare, ve a **Workers & Pages → Create → Pages → Connect to Git** y elige este repositorio.
2. Configura el build así:
   - **Framework preset:** None
   - **Build command:** (vacío)
   - **Build output directory:** `public`
3. Pulsa **Save and Deploy**. La dirección queda como `https://geocr-xxx.pages.dev`.
4. Ve a **Settings → Builds → Build watch paths**. En *Include paths* pon `public/*` y `functions/*`. Así, los cambios en `nax/` no gastan publicaciones.

### 2. Base de datos (D1)
1. En Cloudflare, ve a **Storage & Databases → D1 → Create**. Ponle el nombre `geocr`.
2. En el proyecto de Pages, ve a **Settings → Bindings → Add → D1 database**. Usa el nombre de variable `DB` y elige `geocr`.
3. En **Settings → Variables and Secrets**, agrega `INGEST_TOKEN` de tipo *Secret*. El valor es una clave larga inventada, por ejemplo de 40 letras y números. Guárdala, porque la vas a necesitar en el paso 4.
4. En **Settings → Variables and Secrets**, agrega también la variable `EDITORES`, de tipo *Text*. Su valor son los correos que pueden registrar o corregir lluvias, separados por coma. El resto del personal solo ve los mapas, el historial y la descarga.
5. Vuelve a publicar con **Deployments → … → Retry deployment**. La tabla se crea sola en la primera visita.

### 3. Acceso solo para el personal (Cloudflare Access)
1. En Cloudflare, ve a **Zero Trust → Access → Applications → Add → Self-hosted**.
   - **Dominio:** el de Pages, por ejemplo `geocr-xxx.pages.dev`.
   - **Policy:** *Allow*. En *Include*, elige *Emails* y escribe los correos autorizados.
   - **Login method:** One-time PIN.
2. Crea una **segunda** aplicación Self-hosted para el robot:
   - **Dominio:** el mismo, con la ruta `api/ingest`.
   - **Policy:** *Bypass*, con *Include* en *Everyone*. Esa ruta ya está protegida con el token `INGEST_TOKEN`.
3. Haz lo mismo con `*.geocr-xxx.pages.dev`, que corresponde a las vistas previas, para que también pidan correo.

Para agregar o quitar personas después, edita la lista de correos de la *Policy*.

### 4. Robot de NAX (GitHub)
En este repositorio, ve a **Settings → Secrets and variables → Actions**.

**Secrets:**

| Nombre | Valor |
|---|---|
| `NAX_EMAIL` | El correo de NAX. |
| `NAX_PASSWORD` | La contraseña de NAX. |
| `GEOCR_INGEST_TOKEN` | La misma clave que pusiste en `INGEST_TOKEN` en Cloudflare. |

**Variables:**

| Nombre | Valor |
|---|---|
| `GEOCR_URL` | `https://geocr-xxx.pages.dev` |
| `NAX_CAMPANA` | Opcional. El nombre exacto de la campaña, por ejemplo `12/2026 (SUGARCANE)`. Si no la pones, se usa la primera de la lista, igual que en la ventana del script. |
| `VENTANA_DIAS` | Opcional, por defecto `35`. Son los días de imágenes que se conservan en el histórico. |
| `DIAS_RECIENTES` | Opcional, por defecto `7`. Son los días que se vuelven a pedir cada mañana. |

Para probarlo, ve a **Actions → Alertas NAX diarias → Run workflow**. La primera corrida descarga los 35 días completos y tarda más. Las siguientes solo traen lo nuevo. Cada corrida deja el PDF y el Excel de reporte.py como descarga durante 14 días, y el PDF también queda en el tablero.

---

## Cómo se actualiza la página
Los cambios se piden en Claude. Claude edita `src/`, ejecuta `python build.py` y sube el resultado a GitHub. Cloudflare publica la nueva versión sola en 1–2 minutos.

El plan gratuito permite 500 publicaciones al mes.
