// generate_report.js — Reporte de Productividad Santa Fe
// Lee GitHub Project vía GraphQL y envía reporte a Slack
// Estimate se registra directamente en HORAS (sin conversión)
// Labels: S1/S2/S3 = severidad | termina en PRY = entidad/proyecto | resto = tipo de actividad

import fetch from 'node-fetch';

// ─── Configuración desde variables de entorno ───────────────────────────────
const GH_TOKEN            = process.env.GH_TOKEN;
const SLACK_BOT_TOKEN     = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID    = process.env.SLACK_CHANNEL_ID    || 'C0B55J8C740';
const PROJECT_NUMBER      = parseInt(process.env.GH_PROJECT_NUMBER || '1');
const PROJECT_OWNER       = process.env.GH_PROJECT_OWNER    || 'santafe-mx';
const PROJECT_OWNER_TYPE  = process.env.GH_PROJECT_OWNER_TYPE || 'user'; // 'user' o 'org'
const REPORT_TITLE        = process.env.REPORT_TITLE        || 'Santa Fe';

// ─── Clasificación de Labels ─────────────────────────────────────────────────
const SEVERITIES = new Set(['S1', 'S2', 'S3']);
function classifyLabels(labels = []) {
  const severity     = [];
  const entities     = [];
  const activityType = [];
  for (const l of labels) {
    if (SEVERITIES.has(l))       severity.push(l);
    else if (l.endsWith('PRY'))  entities.push(l);
    else                         activityType.push(l);
  }
  return { severity, entities, activityType };
}

// ─── Query GraphQL paginada ─────────────────────────────────────────────────
function buildQuery(ownerType, cursor = null) {
  const afterClause = cursor ? `, after: "${cursor}"` : '';
  const ownerQuery  = ownerType === 'org'
    ? `organization(login: "${PROJECT_OWNER}")`
    : `user(login: "${PROJECT_OWNER}")`;

  return `{
    ${ownerQuery} {
      projectV2(number: ${PROJECT_NUMBER}) {
        id
        title
        items(first: 100${afterClause}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field { ... on ProjectV2Field { name } }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2Field { name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2Field { name } }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  title
                  startDate
                  duration
                  field { ... on ProjectV2IterationField { name } }
                }
                ... on ProjectV2ItemFieldUserValue {
                  users(first: 5) { nodes { login } }
                  field { ... on ProjectV2Field { name } }
                }
              }
            }
            content {
              ... on Issue {
                title
                state
                assignees(first: 5) { nodes { login } }
                labels(first: 10)   { nodes { name  } }
                createdAt
                closedAt
              }
              ... on DraftIssue {
                title
                assignees(first: 5) { nodes { login } }
              }
            }
          }
        }
      }
    }
  }`;
}

// ─── Llamada a GitHub GraphQL ───────────────────────────────────────────────
async function ghQuery(query) {
  const res = await fetch('https://api.github.com/graphql', {
    method:  'POST',
    headers: {
      'Authorization': `bearer ${GH_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ─── Extracción completa con paginación ────────────────────────────────────
async function fetchAllItems() {
  let allItems = [];
  let cursor   = null;
  let hasNext  = true;
  let projectTitle = '';

  while (hasNext) {
    const data    = await ghQuery(buildQuery(PROJECT_OWNER_TYPE, cursor));
    const owner   = data.organization || data.user;
    const project = owner?.projectV2;

    if (!project) throw new Error(`No se encontró Project #${PROJECT_NUMBER} en ${PROJECT_OWNER}`);

    projectTitle = project.title;
    const page   = project.items;

    allItems = allItems.concat(page.nodes);
    hasNext  = page.pageInfo.hasNextPage;
    cursor   = page.pageInfo.endCursor;

    console.log(`  → Página extraída: ${allItems.length} items acumulados`);
  }

  return { items: allItems, projectTitle };
}

// ─── Parseo de un item — campos Santa Fe ────────────────────────────────────
function parseItem(node) {
  const fields = {};
  for (const fv of node.fieldValues?.nodes || []) {
    const fname = fv.field?.name;
    if (!fname) continue;
    if (fv.name   !== undefined) fields[fname] = fv.name;
    if (fv.number !== undefined) fields[fname] = fv.number;
    if (fv.text   !== undefined) fields[fname] = fv.text;
    if (fv.date   !== undefined) fields[fname] = fv.date;
    if (fv.title  !== undefined) fields[fname] = fv.title;   // Iteración
    if (fv.startDate !== undefined) fields[`${fname}__start`] = fv.startDate; // Iteración startDate
    if (fv.users  !== undefined) fields[fname] = fv.users.nodes.map(u => u.login).join(', ');
  }

  const content   = node.content || {};
  const assignees = content.assignees?.nodes?.map(a => a.login) || [];
  const rawLabels = content.labels?.nodes?.map(l => l.name)    || [];
  const { severity, entities, activityType } = classifyLabels(rawLabels);

  // Estimate viene en horas directamente (sin conversión)
  const hrs = Number(fields['Estimate (hrs)'] || fields['Estimate'] || 0);

  return {
    title:        content.title || '(sin título)',
    status:       fields['Status']       || 'No definido',
    hrs,                                                  // horas directas
    iteracion:    fields['Iteración']    || fields['Iteration'] || 'Sin sprint',
    reportedDate: fields['Reported Date']|| null,
    startDate:    fields['Start Date']   || null,
    plannedDate:  fields['Planned date'] || fields['Planned Date'] || null,
    realDate:     fields['Real Date']    || null,
    assignees:    assignees.length ? assignees : ['Sin asignar'],
    severity:     severity.length  ? severity  : [],
    entities:     entities.length  ? entities  : ['Sin entidad'],
    activityType: activityType.length ? activityType : ['Sin tipo'],
    state:        content.state    || 'OPEN',
    closedAt:     content.closedAt || null,
    createdAt:    content.createdAt|| null,
  };
}

// ─── Análisis y agrupación — Santa Fe ──────────────────────────────────────
function analyzeItems(rawItems) {
  const items = rawItems.map(parseItem);

  const now       = new Date();
  const dayOfWeek = now.getDay();
  const monday    = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  monday.setHours(0, 0, 0, 0);

  const isDone    = s => ['Done', 'Cerrado', 'Closed', 'Completado'].includes(s);
  const isBlocked = s => ['Blocked', 'Bloqueado'].includes(s);

  const weekItems = items.filter(i => {
    const d = i.realDate    ? new Date(i.realDate)
            : i.closedAt    ? new Date(i.closedAt)
            : i.createdAt   ? new Date(i.createdAt)
            : null;
    return d && d >= monday;
  });

  // Agrupación genérica por campo — acumula horas directas
  function groupBy(list, key) {
    const map = {};
    for (const item of list) {
      const vals = Array.isArray(item[key]) ? item[key] : [item[key]];
      for (const v of vals) {
        if (!map[v]) map[v] = { done: 0, pending: 0, blocked: 0, total: 0, count: 0 };
        const h = Number(item.hrs) || 0;
        map[v].total += h;
        map[v].count += 1;
        if (isDone(item.status))         map[v].done    += h;
        else if (isBlocked(item.status)) map[v].blocked += h;
        else                             map[v].pending += h;
      }
    }
    return map;
  }

  // Distribución por severidad
  function severityCount(list) {
    const map = { S1: 0, S2: 0, S3: 0 };
    for (const item of list) {
      for (const s of item.severity) {
        if (map[s] !== undefined) map[s]++;
      }
    }
    return map;
  }

  const year = {
    total:        items.length,
    totalHrs:     items.reduce((s, i) => s + (Number(i.hrs) || 0), 0),
    done:         items.filter(i => isDone(i.status)).length,
    blocked:      items.filter(i => isBlocked(i.status)).length,
    byAssignee:   groupBy(items, 'assignees'),
    byEntity:     groupBy(items, 'entities'),
    byActivity:   groupBy(items, 'activityType'),
    bySeverity:   severityCount(items),
  };

  const week = {
    total:        weekItems.length,
    totalHrs:     weekItems.reduce((s, i) => s + (Number(i.hrs) || 0), 0),
    done:         weekItems.filter(i => isDone(i.status)).length,
    blocked:      weekItems.filter(i => isBlocked(i.status)).length,
    byAssignee:   groupBy(weekItems, 'assignees'),
    byEntity:     groupBy(weekItems, 'entities'),
    bySeverity:   severityCount(weekItems),
  };

  return { year, week };
}

// ─── Formateo de Slack — Santa Fe ──────────────────────────────────────────
function formatSlackReport(projectTitle, stats) {
  const { year, week } = stats;
  const now     = new Date();
  const dateStr = now.toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const yearPct = year.total ? Math.round((year.done / year.total) * 100) : 0;

  // Top assignees
  const topAssignees = Object.entries(year.byAssignee)
    .sort((a, b) => b[1].total - a[1].total).slice(0, 6);

  // Top entidades
  const topEntities = Object.entries(year.byEntity)
    .sort((a, b) => b[1].total - a[1].total).slice(0, 5);

  // Top actividades
  const topActivity = Object.entries(year.byActivity)
    .sort((a, b) => b[1].total - a[1].total).slice(0, 5);

  // Severidades acumulado
  const sev = year.bySeverity;
  const sevWeek = week.bySeverity;

  // Filas assignees
  const assigneeRows = topAssignees.map(([name, d]) => {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `  • *${name}*: ${d.done}h ✓ / ${d.total}h total  ${bar} ${pct}%`;
  }).join('\n');

  const entityRows = topEntities.map(([name, d]) => {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    return `  • *${name}*: ${d.done}h ✓ / ${d.pending}h ⏳ — ${pct}%`;
  }).join('\n');

  const activityRows = topActivity
    .map(([name, d]) => `  • ${name}: ${d.total}h (${d.count} tareas)`).join('\n');

  // Semana — assignees
  const weekAssigneeRows = Object.entries(week.byAssignee)
    .sort((a, b) => b[1].total - a[1].total).slice(0, 5)
    .map(([name, d]) => `  • *${name}*: ${d.total}h (${d.count} tareas)`)
    .join('\n');

  // Alertas
  const alerts = [];
  if (sev.S1 > 0)       alerts.push(`🔴 *${sev.S1} defecto(s) S1* en el acumulado — atención inmediata.`);
  if (sevWeek.S1 > 0)   alerts.push(`🔴 *${sevWeek.S1} defecto(s) S1 esta semana* — escalar.`);
  if (year.blocked > 0) alerts.push(`🚫 *${year.blocked} tarea(s) bloqueadas* — requieren seguimiento.`);
  for (const [name, d] of topAssignees) {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    if (pct < 60 && d.count > 2) alerts.push(`⚠️ *${name}* con ${pct}% completitud — revisar carga.`);
  }
  for (const [name, d] of topEntities) {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    if (pct < 50 && d.count > 3) alerts.push(`🔴 *${name}*: solo ${pct}% avance — revisar con el equipo.`);
  }

  const alertSection = alerts.length
    ? `\n*⚡ Alertas*\n${alerts.join('\n')}`
    : '\n✅ Sin alertas críticas esta semana.';

  return [
    `📊 *Reporte de Productividad — ${REPORT_TITLE}*`,
    `_${dateStr} · GitHub Project #${PROJECT_NUMBER} · Esfuerzo en horas_`,
    `_Proyecto: ${projectTitle}_`,
    '',
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 *ACUMULADO ${now.getFullYear()}*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  Tareas: *${year.total}* total · *${year.done}* Done · *${year.blocked}* bloqueadas`,
    `  Horas registradas: *${year.totalHrs}h*`,
    `  Completitud: *${yearPct}%*`,
    `  Severidades: 🔴 S1: ${sev.S1}  🟡 S2: ${sev.S2}  🟢 S3: ${sev.S3}`,
    '',
    `*👤 Por responsable (Top ${topAssignees.length})*`,
    assigneeRows || '  Sin datos',
    '',
    `*🏢 Por entidad/proyecto*`,
    entityRows || '  Sin datos',
    '',
    `*⚡ Por tipo de actividad*`,
    activityRows || '  Sin datos',
    '',
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🗓 *SEMANA ACTUAL*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  Tareas: *${week.total}* · Done: *${week.done}* · Horas: *${week.totalHrs}h*`,
    `  Severidades semana: 🔴 S1: ${sevWeek.S1}  🟡 S2: ${sevWeek.S2}  🟢 S3: ${sevWeek.S3}`,
    weekAssigneeRows ? `\n*👤 Por responsable*\n${weekAssigneeRows}` : '',
    alertSection,
    '',
    `_Fuente: GitHub Project #${PROJECT_NUMBER} · Generado automáticamente · ${REPORT_TITLE}_`,
  ].filter(l => l !== undefined).join('\n');
}

// ─── Envío a Slack ──────────────────────────────────────────────────────────
async function sendToSlack(text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text,
      mrkdwn: true,
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
  return json;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Iniciando reporte de productividad — ${REPORT_TITLE}`);
  console.log(`   Project #${PROJECT_NUMBER} de ${PROJECT_OWNER} (${PROJECT_OWNER_TYPE})`);
  console.log(`   Slack → ${SLACK_CHANNEL_ID}\n`);

  try {
    // 1. Extraer todos los items del proyecto
    console.log('📥 Extrayendo items de GitHub Project...');
    const { items, projectTitle } = await fetchAllItems();
    console.log(`   ✓ ${items.length} items extraídos del proyecto "${projectTitle}"`);

    // 2. Analizar
    console.log('🔢 Analizando datos...');
    const stats = analyzeItems(items);
    console.log(`   ✓ Año: ${stats.year.total} tareas | Semana: ${stats.week.total} tareas`);

    // 3. Formatear
    const message = formatSlackReport(projectTitle, stats);

    // 4. Enviar a Slack
    console.log('📤 Enviando a Slack...');
    await sendToSlack(message);
    console.log(`   ✓ Reporte enviado exitosamente a ${SLACK_CHANNEL_ID}`);

    console.log('\n✅ Proceso completado.');
  } catch (err) {
    console.error('\n❌ Error en el proceso:', err.message);
    // Notificar el error también a Slack
    try {
      await sendToSlack(`❌ *Error en reporte de productividad — ${REPORT_TITLE}*\n\`${err.message}\``);
    } catch (_) {}
    process.exit(1);
  }
}

main();
