#!/bin/bash
# ─────────────────────────────────────────────────────────────
# SETUP INICIAL — Reporte de Productividad Santa Fe
# Ejecutar desde tu máquina local, una sola vez
# ─────────────────────────────────────────────────────────────

# ── PASO 1: Crear la estructura de carpetas ──────────────────
mkdir -p santafe-productivity-report/.github/workflows
mkdir -p santafe-productivity-report/scripts

# ── PASO 2: Copiar los archivos descargados ──────────────────
# productivity-report.yml  →  .github/workflows/
# generate_report.js       →  scripts/
# package.json             →  scripts/
# README.md                →  raíz del proyecto

# ── PASO 3: Inicializar el repo local ───────────────────────
cd santafe-productivity-report
git init
git branch -M main

# ── PASO 4: Conectar al repo remoto de GitHub ────────────────
git remote add origin https://github.com/santafe-mx/productivity-report.git

# ── PASO 5: Primer commit y push ────────────────────────────
git add .
git commit -m "feat: reporte diario de productividad Santa Fe"
git push -u origin main

echo ""
echo "✅ Push completado. Ahora registra los secrets en GitHub:"
echo ""
echo "   Repo → Settings → Secrets and variables → Actions"
echo ""
echo "   GH_TOKEN        = <tu-github-token-de-santafe-mx>"
echo "   SLACK_BOT_TOKEN = <tu-slack-bot-token-xoxb-...>"
echo ""
echo "   Luego en Slack, dentro de #casf-notifications:"
echo "   /invite @nombre-del-bot"
