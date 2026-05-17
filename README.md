# 📊 Reporte de Productividad — Santa Fe

Automatización diaria que extrae datos de GitHub Project #1 (`santafe-mx`)
y envía el reporte de productividad al canal `#casf-notifications` en Slack.

---

## Estructura

```
.github/
  workflows/
    productivity-report.yml   ← Corre lunes-viernes 8:00 AM CDT
scripts/
  generate_report.js          ← Lógica de extracción y envío
  package.json
README.md
```

---

## Setup inicial (una sola vez)

### 1. Subir este repo a GitHub

```bash
git init
git add .
git commit -m "feat: reporte productividad Santa Fe"
git remote add origin https://github.com/santafe-mx/productivity-report.git
git push -u origin main
```

### 2. Registrar los Secrets en GitHub

Ve a: `Repo → Settings → Secrets and variables → Actions → New repository secret`

| Secret            | Valor                          |
|-------------------|--------------------------------|
| `GH_TOKEN`        | ghp_EjD6ucTPrAsJ0ACad7B4...   |
| `SLACK_BOT_TOKEN` | xoxb-9141089861764-...         |

> ⚠️ Nunca subas los tokens directamente en el código.

### 3. Verificar que el bot está en el canal

En Slack, dentro de `#casf-notifications`:
```
/invite @nombre-del-bot
```

---

## Ejecución manual

Desde GitHub: `Actions → Reporte de Productividad — Santa Fe → Run workflow`

---

## Campos esperados en GitHub Project

El script lee estos campos del Project (mismos que Meltsan):

| Campo           | Tipo              |
|-----------------|-------------------|
| `Status`        | Single Select     |
| `Story points`  | Number            |
| `Client Name`   | Text / Select     |
| `Activity Type` | Text / Select     |
| `Target date`   | Date              |
| `Sprint`        | Iteration         |

Si los campos tienen nombres distintos en el Project de Santa Fe,
editar las líneas de mapeo en `generate_report.js` (sección `parseItem`).

---

## Horario

```
Lunes a Viernes — 8:00 AM CDT (Ciudad de México)
= 14:00 UTC
```

Configurado en `.github/workflows/productivity-report.yml` como cron:
```
0 14 * * 1-5
```

---

## Soporte

Proyecto gestionado por Meltsan Solutions · AML Meltsan® Intelligence
