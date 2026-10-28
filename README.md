# PipelineMonitoring

Monitoriza colas JMS de un tenant de SAP Integration Suite y envía una alerta a un iFlow cuando detecta mensajes detenidos. Especificación completa en [SPEC.md](SPEC.md).

Requisitos: Node.js 24, cf CLI v8. No tiene dependencias npm.

Los comandos `git`, `cf` y `npm` son iguales en todos los sistemas. Donde cambian se indican dos variantes: **Unix** (Linux/macOS, bash o zsh) y **Windows** (cmd).

## 1. Clonar

```bash
git clone https://github.com/manuel-almagro-avvale/PipelineMonitoring
cd PipelineMonitoring
```

## 2. Configurar

Unix:

```bash
cp vars.example.yml vars.yml
```

Windows:

```bat
copy vars.example.yml vars.yml
```

Rellenar `vars.yml`:

| Variable | Contenido |
|---|---|
| `client_slug` | Sufijo del nombre de la app en CF (`pipeline-monitoring-<slug>`). |
| `cpi_api_service_key` | Service key del plan `api` del tenant del cliente, **solo con roles de lectura** (SPEC apartado 3). |
| `alert_service_key` | Service key del plan `integration-flow` del iFlow de alertas. |
| `alert_endpoint_path` | Ruta del endpoint del iFlow, p.e. `/http/pipeline/alert`. |
| `client_name`, `environment` | Identifican al cliente y entorno en la alerta. |
| `monitored_queues` | Nombres exactos de las colas, separados por comas. |
| `monitoring_freq_in_minutes`, `monitoring_wait_in_seconds` | Frecuencia y espera entre lecturas. La espera debe ser menor que la frecuencia × 60. |

Los parámetros opcionales (`STUCK_MESSAGES_MIN_RATIO`, `STUCK_CHECK_SAMPLE_SIZE`, `ALERT_REMINDER_IN_MINUTES`, `LOG_LEVEL`) se activan descomentándolos en `manifest.yml` y añadiéndolos a `vars.yml`, o con `cf set-env <app> <VAR> <valor>` + `cf restage <app>`.

`vars.yml` está en `.gitignore`. No subirlo nunca.

## 3. Autenticarse en el espacio destino

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com --sso
```

```bash
cf target -o <org> -s <space>
```

## 4. Desplegar

```bash
cf push --vars-file vars.yml
```

La app se despliega con 1 instancia, sin ruta pública y con health check `http` sobre `/health`. No escalar a más instancias: se duplicarían las alertas.

## 5. Comprobar que funciona

```bash
cf logs pipeline-monitoring-<client_slug> --recent
```

Al arrancar debe aparecer la línea `Configuración cargada. | Cliente: ...` y, en cada iteración, `Iteración iniciada` / `Iteración finalizada. Próxima iteración a las ...`. Si la configuración es inválida, la app escribe qué variable falla y termina con código 1.

Para seguir los logs en directo:

```bash
cf logs pipeline-monitoring-<client_slug>
```

## Ejecución local

Unix:

```bash
cp .env.example .env
```

Windows:

```bat
copy .env.example .env
```

Rellenar `.env` (service keys en una sola línea) y arrancar:

```bash
npm run start:local
```

El health check queda en `http://localhost:8080/health`.

## Tests

```bash
npm test
```
