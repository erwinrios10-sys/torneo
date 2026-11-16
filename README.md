# Torneo de Pádel: sitio web y mesa de control

Sitio para administrar un torneo de pádel de principio a fin: inscripciones, grupos, llaves, calendario y resultados en vivo.

- **Sitio público** (`/`): los jugadores solo pueden consultar. Ven grupos, calendario, resultados, llaves, el buscador de partidos por nombre, la vista "En vivo" para pantalla y el formulario de inscripción.
- **Mesa de control** (`/admin`): solo tú entras, con tu contraseña. Ahí administras todo.

## Contenido del proyecto

```
public/
  index.html             Sitio público
  admin.html             Mesa de control
  css/styles.css         Estilos (colores editables desde el panel)
  js/engine.js           Motor del torneo: grupos, desempates, llaves, calendario
  js/ui.js               Componentes visuales compartidos
  js/public.js           Lógica del sitio público
  js/admin.js            Lógica de la mesa de control
  js/adapter-netlify.js  Conexión del panel con la API
netlify/functions/api.mjs  API (inscripciones, sesión, guardado, resultados)
tests/engine.test.mjs      Pruebas automáticas del motor
netlify.toml               Configuración de Netlify
package.json
```

Los datos se guardan en **Netlify Blobs**, el almacenamiento integrado de Netlify. No necesitas contratar otra base de datos.

---

## 1. Publicarlo en Netlify

1. Crea un repositorio en GitHub (por ejemplo `torneo-padel`) y sube todos los archivos de esta carpeta.
2. En Netlify ve a **Add new site → Import an existing project → GitHub** y elige el repositorio. La configuración se lee sola desde `netlify.toml`, así que no cambies nada.
3. Antes de publicar, o justo después, ve a **Site configuration → Environment variables** y crea estas variables:

   | Variable | Para qué sirve | Ejemplo |
   |---|---|---|
   | `ADMIN_PASSWORD` | Tu contraseña de mesa de control (acceso total) | una contraseña larga |
   | `SESSION_SECRET` | Clave para firmar las sesiones. Mínimo 16 caracteres al azar | `k8Zq…` (32 caracteres) |
   | `SCORER_PASSWORD` | *(Opcional)* Contraseña de capturista: solo puede registrar marcadores | otra contraseña |

4. Ve a **Deploys → Trigger deploy** para publicar con las variables ya creadas.
5. Abre `https://TU-SITIO.netlify.app/admin`, entra con `ADMIN_PASSWORD` y listo.

> Cada publicación corre primero las pruebas del motor (`npm test`). Si alguna falla, Netlify no publica, así que nunca sube una versión rota.

**Dominio propio:** en Netlify ve a *Domain management → Add a domain*.

## 2. Probarlo antes del torneo

En **Historial y respaldo → Cargar demo** se carga un torneo de ejemplo con 3 categorías y resultados a medias. Practica con él: genera grupos, captura marcadores, arma la llave y revisa el sitio público. Cuando termines, pulsa **Torneo nuevo vacío**. Los datos del torneo, las pistas y los horarios se conservan.

## 3. Flujo de trabajo del torneo

1. **Torneo y pistas:** nombre, fechas, sede, logo, colores, WhatsApp, instrucciones de pago, reglamento, pistas y días y horarios de juego (con la duración de cada partido y el descanso mínimo).
2. **Categorías y reglas:** crea cada categoría con su cupo y define sus reglas:
   - Grupos: tamaño o número de grupos, reparto (por siembra en serpentina, sorteo o manual), evitar parejas del mismo club, cuántas clasifican, mejores terceros y puntos por victoria, derrota y W.O.
   - Orden de desempate: puntos, enfrentamiento directo, diferencia de sets, diferencia de games, etc. Puedes reordenarlo.
   - Formato de partido por etapa: mejor de 3 o pro-set, tie-break, súper tie-break y punto de oro. **Los marcadores se validan con estas reglas.**
   - Llave: siembra cruzada (1A vs 2B), por ranking, aleatoria o manual; sin revancha de grupo; 3er lugar; consolación; y si se genera sola al terminar los grupos.
3. **Inscripciones:** las del sitio llegan como "Por revisar". Confírmalas, marca los pagos, asigna la siembra o agrega parejas a mano. Puedes exportarlas a CSV (se abre en Excel).
4. **Grupos:** "Generar grupos" muestra una vista previa que puedes ajustar. Con "Aplicar" se crean los partidos. Activa "Publicar en el sitio" cuando quieras que se vean.
5. **Calendario:** "Programar automáticamente" asigna pista y hora sin choques. Un jugador inscrito en dos categorías nunca queda en dos partidos al mismo tiempo. Después puedes arrastrar partidos entre celdas para ajustarlos.
6. **Resultados:** el día del torneo trabajarás en esta pantalla. Los botones son *Llamar a pista*, *En juego* y *Resultado*. Para el marcador hay botones grandes de + y −, y también puedes registrar W.O., retiro, partido pospuesto o cancelado. La tabla de posiciones se recalcula sola y los ganadores avanzan en la llave.
7. **Llaves:** "Generar llave" usa a los clasificados. Toca cualquier partido de la llave para capturar su resultado. Al terminar la final aparece el podio de campeones.

**Aviso en el sitio:** desde el Panel publicas un mensaje en la parte superior del sitio, por ejemplo "Retraso de 20 min en pista 3".

**Vista para pantalla o TV:** abre `https://TU-SITIO.netlify.app/#/vivo` en la pantalla del club. Muestra lo que se juega en cada pista y va rotando las tablas y llaves.

## 4. Seguridad y privacidad

- Toda escritura pasa por el servidor, que revisa la sesión. Si alguien entra a `/admin` sin contraseña, no puede cambiar nada.
- Después de 5 intentos fallidos de contraseña, el acceso se bloquea 15 minutos. Las sesiones duran 12 horas.
- El sitio público **nunca** muestra teléfonos, correos ni estado de pago. Solo nombres y club.
- Inscripciones: hay un límite de 10 por hora desde una misma conexión y un campo trampa contra bots.
- Si dos personas editan al mismo tiempo, se avisa del conflicto en lugar de sobrescribir los cambios.

## 5. Respaldo y deshacer

- **Bitácora:** cada resultado capturado se puede deshacer con un clic.
- **Versiones:** se guardan las últimas 40 versiones del torneo y puedes restaurar cualquiera.
- **Exportar e importar JSON:** sirve como respaldo y para pasar datos entre este sitio y la **mesa de control interna** publicada en Claude, que usa exactamente el mismo formato.

## 6. Probarlo en tu computadora (opcional)

```bash
npm install
npm install -g netlify-cli
netlify dev          # abre http://localhost:8888  (pon las variables en un archivo .env)
npm test             # pruebas del motor
```

## 7. Hacer cambios con el agente de IA de Netlify

El código está organizado para que el agente de Netlify pueda modificarlo. Algunos ejemplos de lo que puedes pedirle:

- "Add a sponsor carousel to the home page."
- "Add a 'Fotos' tab that shows images uploaded from /admin."

Pídele que **no cambie `public/js/engine.js` sin correr `npm test`**. Ese archivo contiene las reglas del torneo.
