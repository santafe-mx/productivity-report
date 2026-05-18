// generate_report.js — Reporte de Productividad Santa Fe
// Estimate en horas directas (sin conversión)
// Labels: S1/S2/S3 = severidad | termina en PRY = entidad | resto = tipo actividad
// Semana corriente: filtrada por campo "Iteración" que coincide con la semana calendario actual

import fetch from 'node-fetch';

// ─── Configuración ───────────────────────────────────────────────────────────
const GH_TOKEN           = process.env.GH_TOKEN;
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID   = process.env.SLACK_CHANNEL_ID     || 'C0B55J8C740';
const PROJECT_NUMBER     = parseInt(process.env.GH_PROJECT_NUMBER || '1');
const PROJECT_OWNER      = process.env.GH_PROJECT_OWNER     || 'santafe-mx';
const PROJECT_OWNER_TYPE = process.env.GH_PROJECT_OWNER_TYPE || 'user';
const REPORT_TITLE       = process.env.REPORT_TITLE         || 'Santa Fe';

// ─── Statuses definidos ──────────────────────────────────────────────────────
const STATUS = {
  BACKLOG:       'Backlog',
  SPRINT_BACKLOG:'Sprint Backlog',
  IN_PROGRESS:   'In Progress',
  READY_TEST:    'Ready to Test',
  READY_PROD:    'Ready for Production',
  IN_REVIEW:     'In Review',
  DONE:          'Done',
};
const ALL_STATUSES = Object.values(STATUS);

// ─── Clasificación de Labels ──────────────────────────────────────────────────
const SEVERITIES = new Set(['S1', 'S2', 'S3']);
function classifyLabels(labels = []) {
  const severity = [], entities = [], activityType = [];
  for (const l of labels) {
    if (SEVERITIES.has(l))      severity.push(l);
    else if (l.endsWith('PRY')) entities.push(l);
    else                        activityType.push(l);
  }
  return { severity, entities, activityType };
}

// ─── Semana calendario actual ─────────────────────────────────────────────────
function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

function isCurrentWeekIteration(startDate) {
  if (!startDate) return false;
  const { monday, sunday } = getCurrentWeekRange();
  const d = new Date(startDate);
  return d >= monday && d <= sunday;
}

// ─── Query GraphQL paginada ───────────────────────────────────────────────────
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

// ─── GitHub GraphQL ───────────────────────────────────────────────────────────
async function ghQuery(query) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${GH_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    throw new Error(json.errors[0]?.message || JSON.stringify(json.errors));
  }
  if (!json.data) throw new Error('GitHub no devolvió datos. Verifica el token y permisos.');
  return json.data;
}

// ─── Extracción paginada ──────────────────────────────────────────────────────
async function fetchAllItems() {
  let allItems = [], cursor = null, hasNext = true, projectTitle = '';
  while (hasNext) {
    const data    = await ghQuery(buildQuery(PROJECT_OWNER_TYPE, cursor));
    const owner   = data.organization || data.user;
    const project = owner?.projectV2;
    if (!project) throw new Error(`No se encontró Project #${PROJECT_NUMBER} en ${PROJECT_OWNER}`);
    projectTitle  = project.title;
    const page    = project.items;
    allItems      = allItems.concat(page.nodes);
    hasNext       = page.pageInfo.hasNextPage;
    cursor        = page.pageInfo.endCursor;
    console.log(`  → Página extraída: ${allItems.length} items acumulados`);
  }
  return { items: allItems, projectTitle };
}

// ─── Parseo de item ───────────────────────────────────────────────────────────
function parseItem(node) {
  const fields = {};
  for (const fv of node.fieldValues?.nodes || []) {
    const fname = fv.field?.name;
    if (!fname) continue;
    if (fv.name      !== undefined) fields[fname]             = fv.name;
    if (fv.number    !== undefined) fields[fname]             = fv.number;
    if (fv.text      !== undefined) fields[fname]             = fv.text;
    if (fv.date      !== undefined) fields[fname]             = fv.date;
    if (fv.title     !== undefined) fields[fname]             = fv.title;
    if (fv.startDate !== undefined) fields[`${fname}__start`] = fv.startDate;
    if (fv.duration  !== undefined) fields[`${fname}__dur`]   = fv.duration;
    if (fv.users     !== undefined) fields[fname]             = fv.users.nodes.map(u => u.login).join(', ');
  }

  const content   = node.content || {};
  const assignees = content.assignees?.nodes?.map(a => a.login) || [];
  const rawLabels = content.labels?.nodes?.map(l => l.name)    || [];
  const { severity, entities, activityType } = classifyLabels(rawLabels);

  const hrs           = Number(fields['Estimate (hrs)'] || fields['Estimate'] || 0);
  const iterTitle     = fields['Iteración']        || fields['Iteration']       || null;
  const iterStartDate = fields['Iteración__start'] || fields['Iteration__start'] || null;

  return {
    title:        content.title || '(sin título)',
    status:       fields['Status']       || 'No definido',
    hrs,
    iterTitle,
    iterStartDate,
    reportedDate: fields['Reported Date'] || null,
    startDate:    fields['Start Date']    || null,
    plannedDate:  fields['Planned date']  || fields['Planned Date'] || null,
    realDate:     fields['Real Date']     || null,
    refDate:      fields['Reported Date'] || content.createdAt || null,
    assignees:    assignees.length    ? assignees    : ['Sin asignar'],
    severity:     severity.length     ? severity     : [],
    entities:     entities.length     ? entities     : ['Sin entidad'],
    activityType: activityType.length ? activityType : ['Sin tipo'],
    state:        content.state       || 'OPEN',
    closedAt:     content.closedAt    || null,
    createdAt:    content.createdAt   || null,
  };
}

// ─── Análisis ─────────────────────────────────────────────────────────────────
function analyzeItems(rawItems) {
  const now   = new Date();
  const start = new Date(`${now.getFullYear()}-01-01T00:00:00`);

  // Filtro anual por Reported Date o createdAt
  const items = rawItems.map(parseItem).filter(i => {
    const d = i.refDate ? new Date(i.refDate) : null;
    return !d || d >= start;
  });

  // Indicadores por status
  function statusIndicator(list) {
    const map = {};
    for (const s of ALL_STATUSES) map[s] = { count: 0, hrs: 0 };
    map['Otros'] = { count: 0, hrs: 0 };
    for (const item of list) {
      const key = ALL_STATUSES.includes(item.status) ? item.status : 'Otros';
      map[key].count += 1;
      map[key].hrs   += Number(item.hrs) || 0;
    }
    return map;
  }

  // Agrupación genérica
  function groupBy(list, key) {
    const map = {};
    for (const item of list) {
      const vals = Array.isArray(item[key]) ? item[key] : [item[key]];
      for (const v of vals) {
        if (!map[v]) map[v] = { count: 0, hrs: 0 };
        map[v].count += 1;
        map[v].hrs   += Number(item.hrs) || 0;
      }
    }
    return map;
  }

  // Severidades
  function severityCount(list) {
    const map = { S1: 0, S2: 0, S3: 0 };
    for (const item of list) {
      for (const s of item.severity) {
        if (map[s] !== undefined) map[s]++;
      }
    }
    return map;
  }

  // Semana corriente por iteración
  const weekItems = items.filter(i => isCurrentWeekIteration(i.iterStartDate));
  const weekRange = getCurrentWeekRange();

  return {
    yearTotal:      items.length,
    yearHrs:        items.reduce((s, i) => s + (Number(i.hrs) || 0), 0),
    yearByStatus:   statusIndicator(items),
    yearSeverity:   severityCount(items),
    weekRange,
    weekTotal:      weekItems.length,
    weekHrs:        weekItems.reduce((s, i) => s + (Number(i.hrs) || 0), 0),
    weekByStatus:   statusIndicator(weekItems),
    weekByActivity: groupBy(weekItems, 'activityType'),
    weekByAssignee: groupBy(weekItems, 'assignees'),
    weekSeverity:   severityCount(weekItems),
  };
}

// ─── Formato Slack ────────────────────────────────────────────────────────────
function fmt(count, hrs) {
  return `*${count}* tareas · *${hrs}h*`;
}

function formatSlackReport(projectTitle, s) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const mondayStr = s.weekRange.monday.toLocaleDateString('es-MX', { day:'2-digit', month:'short' });
  const sundayStr = s.weekRange.sunday.toLocaleDateString('es-MX', { day:'2-digit', month:'short' });

  const ys   = s.yearByStatus;
  const ws   = s.weekByStatus;
  const sev  = s.yearSeverity;
  const sevW = s.weekSeverity;

  // Actividades semana (sin "Sin tipo")
  const actRows = Object.entries(s.weekByActivity)
    .filter(([k]) => k !== 'Sin tipo')
    .sort((a, b) => b[1].hrs - a[1].hrs)
    .map(([name, d]) => `  • ${name}: *${d.count}* tareas · *${d.hrs}h*`)
    .join('\n');

  // Assignees semana
  const assigneeRows = Object.entries(s.weekByAssignee)
    .sort((a, b) => b[1].hrs - a[1].hrs)
    .map(([name, d]) => `  • *${name}*: ${d.count} tareas · ${d.hrs}h`)
    .join('\n');

  // Alertas
  const alerts = [];
  if (sev.S1 > 0)  alerts.push(`🔴 *${sev.S1} defecto(s) S1* en el acumulado — atención inmediata.`);
  if (sevW.S1 > 0) alerts.push(`🔴 *${sevW.S1} S1 esta semana* — escalar de inmediato.`);
  const donePct = s.yearTotal ? Math.round((ys[STATUS.DONE].count / s.yearTotal) * 100) : 0;
  if (donePct < 50) alerts.push(`⚠️ Completitud anual en *${donePct}%* — revisar avance general.`);

  const alertSection = alerts.length
    ? `*⚡ Alertas*\n${alerts.join('\n')}`
    : '✅ Sin alertas críticas.';

  return [
    `📊 *Reporte de Productividad — ${REPORT_TITLE}*`,
    `_${dateStr} · GitHub Project #${PROJECT_NUMBER} · Esfuerzo en horas_`,
    `_Proyecto: ${projectTitle}_`,
    '',
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 *INDICADORES GLOBALES ${now.getFullYear()} · ${s.yearTotal} tareas · ${s.yearHrs}h*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  📋 Backlog:              ${fmt(ys[STATUS.BACKLOG].count,        ys[STATUS.BACKLOG].hrs)}`,
    `  📌 Sprint Backlog:       ${fmt(ys[STATUS.SPRINT_BACKLOG].count, ys[STATUS.SPRINT_BACKLOG].hrs)}`,
    `  🔄 In Progress:          ${fmt(ys[STATUS.IN_PROGRESS].count,   ys[STATUS.IN_PROGRESS].hrs)}`,
    `  🔍 In Review:            ${fmt(ys[STATUS.IN_REVIEW].count,     ys[STATUS.IN_REVIEW].hrs)}`,
    `  🧪 Ready to Test:        ${fmt(ys[STATUS.READY_TEST].count,    ys[STATUS.READY_TEST].hrs)}`,
    `  🚀 Ready for Production: ${fmt(ys[STATUS.READY_PROD].count,    ys[STATUS.READY_PROD].hrs)}`,
    `  ✅ Done:                 ${fmt(ys[STATUS.DONE].count,          ys[STATUS.DONE].hrs)}`,
    `  Severidades año: 🔴 S1: ${sev.S1}  🟡 S2: ${sev.S2}  🟢 S3: ${sev.S3}`,
    '',
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🗓 *SEMANA CORRIENTE · ${mondayStr} – ${sundayStr} · ${s.weekTotal} tareas · ${s.weekHrs}h*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  📌 Sprint Backlog:       ${fmt(ws[STATUS.SPRINT_BACKLOG].count, ws[STATUS.SPRINT_BACKLOG].hrs)}`,
    `  🔄 In Progress:          ${fmt(ws[STATUS.IN_PROGRESS].count,   ws[STATUS.IN_PROGRESS].hrs)}`,
    `  🧪 Ready to Test:        ${fmt(ws[STATUS.READY_TEST].count,    ws[STATUS.READY_TEST].hrs)}`,
    `  🚀 Ready for Production: ${fmt(ws[STATUS.READY_PROD].count,    ws[STATUS.READY_PROD].hrs)}`,
    `  ✅ Done:                 ${fmt(ws[STATUS.DONE].count,          ws[STATUS.DONE].hrs)}`,
    `  Severidades semana: 🔴 S1: ${sevW.S1}  🟡 S2: ${sevW.S2}  🟢 S3: ${sevW.S3}`,
    '',
    `*⚡ Por tipo de actividad — semana*`,
    actRows || '  Sin actividades registradas esta semana',
    '',
    `*👤 Por responsable — semana*`,
    assigneeRows || '  Sin asignaciones esta semana',
    '',
    alertSection,
    '',
    `_Fuente: GitHub Project #${PROJECT_NUMBER} · Generado automáticamente · ${REPORT_TITLE}_`,
  ].join('\n');
}

// ─── Envío a Slack ────────────────────────────────────────────────────────────
async function sendToSlack(text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text, mrkdwn: true }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
  return json;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Iniciando reporte — ${REPORT_TITLE}`);
  console.log(`   Project #${PROJECT_NUMBER} · ${PROJECT_OWNER} (${PROJECT_OWNER_TYPE})`);
  console.log(`   Slack → ${SLACK_CHANNEL_ID}\n`);

  try {
    console.log('📥 Extrayendo items de GitHub Project...');
    const { items, projectTitle } = await fetchAllItems();
    console.log(`   ✓ ${items.length} items extraídos · "${projectTitle}"`);

    console.log('🔢 Analizando datos...');
    const stats = analyzeItems(items);
    console.log(`   ✓ Año: ${stats.yearTotal} tareas | Semana: ${stats.weekTotal} tareas`);

    const message = formatSlackReport(projectTitle, stats);

    console.log('📤 Enviando a Slack...');
    await sendToSlack(message);
    console.log(`   ✓ Reporte enviado a ${SLACK_CHANNEL_ID}`);
    console.log('\n✅ Proceso completado.');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    try {
      await sendToSlack(`❌ *Error en reporte — ${REPORT_TITLE}*\n\`${err.message}\``);
    } catch (_) {}
    process.exit(1);
  }
}

main();
