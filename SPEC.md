# PipelineMonitoring — Especificación

## 1. Resumen

Aplicación Node.js para Cloud Foundry (SAP BTP) que consulta periódicamente las colas JMS de un tenant de SAP Integration Suite y envía una alerta a un endpoint REST cuando detecta mensajes detenidos.

- **Nombre:** PipelineMonitoring
- **Stack:** Node.js
- **Sin frontend**, sin XSUAA, sin roles ni gestión de usuarios.
- **Stateless:** no hay almacenamiento persistente. La configuración se inyecta mediante variables de entorno; el único estado (lecturas en curso y alertas ya notificadas) vive en memoria y se pierde al reiniciar. La alternativa seria instanciar una base d edatos HANA o PostgreSQL (se sale del scope de lo que buscamos aquí).
- **Despliegue:** en un espacio CF de nuestra propia global account, distinta de la global account del cliente donde vive el tenant de Integration Suite. Por eso las credenciales se pasan como variables de entorno y no mediante service bindings, que sería lo más "elegante".
- **Un despliegue por cliente y entorno.**

## 2. Configuración

Todos los parámetros se leen de variables de entorno al arrancar.

| Parámetro | Variable de entorno | Tipo | Obligatorio | Por defecto | Descripción |
|---|---|---|---|---|---|
| Service key API | `CPI_API_SERVICE_KEY` | JSON (string) | Sí | — | Service key del plan `api` de Integration Suite del cliente. **Solo lectura** (ver apartado 3). |
| Service key alertas | `ALERT_SERVICE_KEY` | JSON (string) | Sí | — | Service key del plan `integration-flow` del iFlow que recibe las alertas. |
| `AlertEndpointPath` | `ALERT_ENDPOINT_PATH` | string | Sí | — | Ruta del endpoint del iFlow, p.e. `/http/pipeline/alert`. Se concatena al host de `ALERT_SERVICE_KEY`. |
| `ClientName` | `CLIENT_NAME` | string | Sí | — | Identificador del cliente, p.e. `VetClinic`. |
| `Environment` | `ENVIRONMENT` | string | Sí | — | Entorno monitorizado, p.e. `sandbox`, `dev`, `qua`, `prod`. |
| `MonitoredQueues` | `MONITORED_QUEUES` | lista separada por comas | Sí (puede estar vacía) | — | Nombres exactos de las colas JMS a monitorizar. |
| `MonitoringFreqInMinutes` | `MONITORING_FREQ_IN_MINUTES` | entero > 0 | Sí | — | Frecuencia entre iteraciones. |
| `MonitoringWaitInSeconds` | `MONITORING_WAIT_IN_SECONDS` | entero > 0 | Sí | — | Espera entre la primera y la segunda lectura de una iteración. |
| `StuckMessagesMinRatio` | `STUCK_MESSAGES_MIN_RATIO` | decimal en (0, 1] | No | `1.0` | Fracción mínima de los mensajes de la muestra de la primera lectura que deben seguir en la cola en la segunda para considerarla detenida (ver apartado 5.4). |
| `StuckCheckSampleSize` | `STUCK_CHECK_SAMPLE_SIZE` | entero > 0 | No | `20` | Número máximo de mensajes por cola cuya permanencia se comprueba entre lecturas (ver apartado 5.3). |
| `AlertReminderInMinutes` | `ALERT_REMINDER_IN_MINUTES` | entero ≥ 0 | No | `0` | Si es > 0, se reenvía la alerta de una cola que sigue detenida cada N minutos. `0` = solo se avisa una vez. |
| `LogLevel` | `LOG_LEVEL` | `error` \| `warn` \| `info` \| `debug` | No | `info` | Nivel de log. |

### 2.1 Gestión de credenciales

- Las service keys **nunca** se suben al repositorio.
- Mecanismo recomendado: `manifest.yml` con variables `((...))` y un fichero `vars.yml` local, incluido en `.gitignore`, que se pasa con `cf push --vars-file vars.yml`. El repo incluye `vars.example.yml` con valores de ejemplo.
- Alternativa: `cf set-env` + `cf restage`.
- Las variables de entorno son visibles para cualquier usuario con rol Space Developer en el espacio (`cf env`). El acceso al espacio debe restringirse en consecuencia.

### 2.2 Validación al arrancar

La app valida la configuración antes de iniciar el ciclo. Si algo falla, escribe en el log un error que indica exactamente qué variable y por qué, y termina con código de salida 1:

- Falta alguna variable obligatoria o tiene un formato inválido.
- `CPI_API_SERVICE_KEY` o `ALERT_SERVICE_KEY` no son JSON válido o les faltan los campos necesarios (`clientid`, `clientsecret`, `tokenurl`, `url`).
- **Solapamiento:** `MONITORING_WAIT_IN_SECONDS >= MONITORING_FREQ_IN_MINUTES × 60`. El mensaje de error indica ambos valores y que las iteraciones se pisarían.

Si `MONITORED_QUEUES` está vacía, la app **no falla**: arranca, no monitoriza ninguna cola y escribe un warning en el arranque y en cada iteración.

Tras una validación correcta, la app escribe un resumen de la configuración efectiva **sin secretos**: cliente, entorno, colas, frecuencia, espera, ratio, recordatorio y hosts.

## 3. Permisos de solo lectura (obligatorio)

La service key del plan `api` en el tenant del cliente debe crearse **exclusivamente con roles de lectura**.

- Solo se asignan los roles de lectura mínimos (en general, `Read*`) para las entidades usadas en apartado 5: `MessagingQueues` y `MessagingMessages`. Determinar los roles concretos es responsabilidad del desarrollador.
- **Prohibido** cualquier rol que permita modificar, borrar, mover o reintentar mensajes o colas, desplegar o modificar contenido de integración, o cualquier otra escritura en el tenant del cliente.
- **Defensa adicional en el código:** el cliente HTTP de la API de Integration Suite solo implementa `GET`. Cualquier otro método lanza una excepción. Esta regla se comprueba en code review.

La service key de alertas (plan `integration-flow`) solo necesita el rol de envío de mensajes al iFlow.

## 4. Autenticación

### 4.1 API de Integration Suite

- OAuth 2.0 client credentials contra el `tokenurl` de `CPI_API_SERVICE_KEY`.
- Base URL: `url` de la service key + `/api/v1`.
- El token se cachea en memoria hasta su expiración (`expires_in` menos un margen de 60 s) y se renueva solo cuando hace falta.
- Ante un `401` se invalida el token cacheado, de modo que la siguiente iteración pida uno nuevo.

### 4.2 Endpoint de alertas

- OAuth 2.0 client credentials contra el `tokenurl` de `ALERT_SERVICE_KEY`. Las service keys basadas en certificado quedan fuera de alcance.
- URL: `url` de la service key + `ALERT_ENDPOINT_PATH`.
- La protección CSRF está desactivada en el sender adapter HTTPS del iFlow, por lo que no se solicita token CSRF.
- Token cacheado igual que en apartado 4.1, en una caché independiente.

## 5. Ciclo de monitorización

### 5.1 Planificación

- Las iteraciones se encadenan con `setTimeout` (nunca `setInterval`), de modo que **nunca hay dos iteraciones en curso a la vez**.
- La siguiente iteración se programa `MonitoringFreqInMinutes` después del **inicio** de la anterior. Si la anterior terminó más tarde (p.e. por timeouts o reintentos), la siguiente empieza inmediatamente y se registra un warning.
- Cada petición HTTP tiene un timeout de 30 s.

### 5.2 Pasos de una iteración

1. **Primera lectura de colas:** `GET /MessagingQueues`.
   ```json
   {
     "d": {
       "results": [
         { "queueName": "string", "numberOfMessages": "string", "active": true, "exclusive": true }
       ]
     }
   }
   ```
2. **Filtrado:** se conservan solo las colas de `MonitoredQueues`. Por cada cola configurada que no aparezca en la respuesta se escribe un warning (`Cola configurada no encontrada en el tenant: <nombre>`).
3. **Parseo:** `numberOfMessages` llega como string y se convierte a entero. Si no es parseable, la cola se excluye de la iteración con un warning.
4. Se construye el mapa `queueName --> numberOfMessages`.
5. **Si ninguna cola tiene mensajes:** se registra en el log, todas las colas en seguimiento se marcan como recuperadas (apartado 6) y la iteración termina.
6. **Primera instantánea de mensajes:** para cada cola con mensajes > 0 se consultan sus mensajes y se guarda una muestra de JMS Message IDs (apartado 5.3). **No** se usa el Correlation ID.
7. **Espera** de `MonitoringWaitInSeconds`.
8. **Segunda lectura:** se repiten los pasos 1–3 y, para las colas candidatas, se comprueba qué IDs de la muestra siguen en la cola (apartado 5.3).
9. **Evaluación** de cada cola candidata según apartado 5.4.
10. **Deduplicación** según apartado 6.
11. **Envío** de la alerta si hay al menos una cola que notificar (apartado 7). Si no hay ninguna, no se envía nada.

### 5.3 Consulta de mensajes de una cola

Endpoint: `GET /MessagingQueues('{queueName}')/MessagingMessages?$format=json`

Identificador único de mensaje: **JMS Message ID** (`jmsMessageId`). Cuando se usa como filtro, se codifica para la URL.

Procedimiento:

1. **Primera lectura:** se obtiene la lista de mensajes de la cola. Si devuelve menos filas que `numberOfMessages`, la lista está truncada y se registra a nivel `debug`. De las filas devueltas se toma una muestra de hasta `StuckCheckSampleSize` JMS Message IDs.
2. **Segunda lectura:** se vuelve a pedir la lista de mensajes de la cola.
   - Cada ID de la muestra que aparezca en la lista --> **presente**.
   - Si la lista no está truncada, los IDs que no aparecen --> **ausentes**.
   - Si la lista está truncada, cada ID que no aparece se comprueba individualmente con `GET /MessagingQueues('{queueName}')/MessagingMessages?jmsMessageId={id}&$format=json`: **presente** si devuelve al menos una fila, **ausente** en caso contrario.

En el peor caso, esto supone `StuckCheckSampleSize` peticiones adicionales por cola candidata y por iteración.

### 5.4 Criterio de cola detenida

Una cola se considera **afectada** si se cumplen **todas** estas condiciones:

1. `numberOfMessages` en la segunda lectura **> 0**.
2. `numberOfMessages` en la segunda lectura **≥** el de la primera (crecimiento monótono).
3. La fracción de IDs de la muestra que siguen presentes en la segunda lectura (apartado 5.3) es **≥ `StuckMessagesMinRatio`**. Es decir, los mensajes que ya estaban siguen ahí, posiblemente junto con otros nuevos.

Si la muestra está vacía (p.e. la cola se vació entre la lectura de colas y la de mensajes), la condición 3 no se puede evaluar: la cola se evalúa solo con las condiciones 1 y 2 y se registra un warning.

Si una cola tiene estrictamente menos mensajes que en la primera lectura, se descarta del análisis y se registra a nivel `info`.

### 5.5 Gestión de errores de la API

- Cualquier error de la API de Integration Suite (`401`, `403`, `5xx`, timeout, respuesta no parseable) se registra con: endpoint, código HTTP y el cuerpo de la respuesta truncado a 500 caracteres y sin secretos.
- La iteración en curso termina y la app **no cae**. La siguiente iteración se ejecuta según lo planificado.

## 6. Deduplicación de alertas

Estado en memoria por cola: `{ firstDetectedAt, lastNotifiedAt }`.

| Situación en la iteración | Acción |
|---|---|
| Cola afectada que no estaba en seguimiento | Se notifica y se registra en el estado. |
| Cola afectada que ya estaba en seguimiento | No se notifica, salvo que `AlertReminderInMinutes > 0` y hayan pasado al menos esos minutos desde `lastNotifiedAt`. |
| Cola en seguimiento que ya no está afectada (o la cola está vacía) | Se elimina del estado y se registra `info`: `Cola <nombre> recuperada`. No se envía alerta. |
| Iteración interrumpida por error de API | El estado no cambia. |

- Una cola solo se marca como notificada si el envío de la alerta tuvo éxito. Si fallan todos los reintentos, se volverá a intentar en la siguiente iteración.
- Tras un reinicio el estado se pierde, así que como mucho se recibe una alerta duplicada por cola.

## 7. Alerta

### 7.1 Payload

`POST` a la URL de apartado 4.2 con `Content-Type: application/json`:

```json
{
  "Client": "VetClinic",
  "Environment": "prod",
  "Timestamp": "2026-10-28T09:15:00.000Z",
  "AffectedQueues": [
    {
      "QueueName": "JMS_ORDERS_IN",
      "PreviousQueuedMessages": 12,
      "QueuedMessages": 15,
      "Active": true,
      "FirstDetectedAt": "2026-10-28T08:15:00.000Z"
    }
  ]
}
```

- `Timestamp` y `FirstDetectedAt` en UTC, formato ISO 8601 (`Date.prototype.toISOString()`).
- `PreviousQueuedMessages` y `QueuedMessages` son números (primera y segunda lectura).
- `Active` es el valor de `active` en la segunda lectura.
- `AffectedQueues` contiene solo las colas que se notifican en esta iteración según apartado 6. Nunca se envía con la lista vacía.

### 7.2 Reintentos

- Hasta **3 reintentos** tras el primer intento fallido (4 intentos en total), con 10 s de espera entre intentos.
- Cada intento fallido se registra como `warn` con el número de intento, el código HTTP o el error. Si fallan todos, se registra un `error` con las colas que no se pudieron notificar.

## 8. Logs

- Son visibles en el cockpit de BTP (Logs de la aplicación) y con `cf logs`. El buffer de CF es pequeño y de vida corta; la retención a largo plazo (SAP Cloud Logging u otro servicoi de persistencia) queda fuera de alcance.
- Formato: una línea por evento, legible por un operador, con timestamp UTC, nivel y mensaje. Ejemplos:
  ```
  2026-10-28T09:15:00.120Z INFO  Iteración iniciada. Colas monitorizadas: JMS_ORDERS_IN, JMS_INVOICES_OUT
  2026-10-28T09:15:00.480Z INFO  Primera lectura: JMS_ORDERS_IN=12, JMS_INVOICES_OUT=0. Esperando 60 s para la segunda lectura.
  2026-10-28T09:16:00.910Z WARN  Cola JMS_ORDERS_IN detenida: 12 --> 15 mensajes, 100% de los mensajes previos siguen en cola.
  2026-10-28T09:16:01.300Z INFO  Alerta enviada correctamente (1 cola).
  2026-10-28T09:16:01.301Z INFO  Iteración finalizada. Próxima iteración a las 09:20:00Z.
  ```
- **Nunca** se escriben en el log tokens, client secrets ni service keys completas.

## 9. Resiliencia y health check

### 9.1 Reinicio

- CF reinicia automáticamente las instancias que crashean o se quedan sin memoria; la app no implementa lógica de reinicio propia.
- Los errores fatales no se silencian: ante `uncaughtException` o `unhandledRejection` se escribe un `error` en el log y el proceso termina con código 1 para que CF lo reinicie.
- Los errores de dependencias externas (API, endpoint de alertas) **nunca** tumban la app (apartado 5.5, apartado 7.2).
- Ante parada o redespliegue manual se registra el evento y el proceso termina limpiamente.
- Una parada manual (`cf stop`) no se recupera automáticamente. Es el comportamiento esperado.

### 9.2 Endpoint `/health`

Según https://docs.cloudfoundry.org/devguide/deploy-apps/healthchecks.html:

- Health check de tipo `http` sobre `/health`, escuchando en `$PORT`.
- Devuelve `200 {"status":"UP"}` si:
  - la app aún no ha completado ninguna iteración y lleva menos de `2 × (MonitoringFreqInMinutes × 60 + MonitoringWaitInSeconds)` segundos arrancada, **o**
  - la última iteración terminó hace menos de ese mismo intervalo.
- En cualquier otro caso devuelve `503 {"status":"DOWN"}` y CF reinicia la instancia.
- Una iteración cuenta como terminada **aunque haya fallado contra la API**. El health check mide si el bucle de la app está vivo, no la salud de las dependencias. Así se evita que CF reinicie en bucle cuando el problema está en el tenant del cliente.
- La respuesta no incluye información interna.
- La app se despliega con `no-route: true` para no exponer `/health` públicamente (el health check de CF accede directamente al contenedor). Hay que verificarlo en el primer despliegue; si fuera necesaria una ruta, `/health` seguirá sin exponer información interna.

## 10. Despliegue

`manifest.yml` de referencia:

```yaml
applications:
  - name: pipeline-monitoring-((client_slug))   # identifica al cliente: pipeline-monitoring-telefonica, -serveo, -mercedes...
    stack: cflinuxfs5     # cflinuxfs4 está deprecado
    buildpacks:
      - nodejs_buildpack
    memory: 128M          # uso real ~30 MB; margen para picos al parsear respuestas de la API
    disk_quota: 512M
    instances: 1          # OBLIGATORIO: con más de una instancia se duplican las alertas (no hay coordinación entre instancias). No usar autoescalado.
    no-route: true
    health-check-type: http
    health-check-http-endpoint: /health
    command: node src/index.js   # sin npm como proceso padre: menos memoria y SIGTERM llega directo a la app
    env:
      CPI_API_SERVICE_KEY: ((cpi_api_service_key))
      ALERT_SERVICE_KEY: ((alert_service_key))
      ALERT_ENDPOINT_PATH: ((alert_endpoint_path))
      CLIENT_NAME: ((client_name))
      ENVIRONMENT: ((environment))
      MONITORED_QUEUES: ((monitored_queues))
      MONITORING_FREQ_IN_MINUTES: ((monitoring_freq_in_minutes))
      MONITORING_WAIT_IN_SECONDS: ((monitoring_wait_in_seconds))
```

## 11. Fuera de alcance

Frontend, XSUAA, persistencia, retención de logs (SAP Cloud Logging), autenticación por certificado, monitorización de varios clientes o entornos desde una misma instancia.

## 12. Entregables

Repositorio corporativo de GitHub con:

- `SPEC.md`: esta especificación.
- `README.md`: cómo clonar, configurar (`vars.yml`), autenticarse con `cf login` en el espacio destino, desplegar (`cf push --vars-file vars.yml`) y comprobar que funciona (`cf logs`). Sin texto de relleno.
- `manifest.yml`, `vars.example.yml`, `.gitignore` (incluye `vars.yml`, `.env`, `node_modules`), `.cfignore`.
- `package.json` con la versión de Node fijada en `engines`.
- Código fuente.
