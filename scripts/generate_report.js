// generate_report.js — Reporte de Productividad Santa Fe v3
import fetch from 'node-fetch';

const GH_TOKEN           = process.env.GH_TOKEN;
const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID   = process.env.SLACK_CHANNEL_ID     || 'C0B55J8C740';
const PROJECT_NUMBER     = parseInt(process.env.GH_PROJECT_NUMBER || '1');
const PROJECT_OWNER      = process.env.GH_PROJECT_OWNER     || 'santafe-mx';
const PROJECT_OWNER_TYPE = process.env.GH_PROJECT_OWNER_TYPE || 'user';
const REPORT_TITLE       = process.env.REPORT_TITLE         || 'Santa Fe';

const STATUS = {
  BACKLOG:        'Backlog',
  SPRINT_BACKLOG: 'Sprint Backlog',
  IN_PROGRESS:    'In Progress',
  READY_TEST:     'Ready to Test',
  READY_PROD:     'Ready for Production',
  IN_REVIEW:      'In Review',
  DONE:           'Done',
};
const ALL_STATUSES = Object.values(STATUS);
const SEVERITIES   = new Set(['S1','S2','S3']);

function classifyLabels(labels = []) {
  const severity = [], entities = [], activityType = [];
  for (const l of labels) {
    if (SEVERITIES.has(l))      severity.push(l);
    else if (l.endsWith('PRY')) entities.push(l);
    else                        activityType.push(l);
  }
  return { severity, entities, activityType };
}

function getWeekRange() {
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

function isThisWeek(startDate) {
  if (!startDate) return false;
  const { monday, sunday } = getWeekRange();
  const d = new Date(startDate);
  return d >= monday && d <= sunday;
}

function buildQuery(ownerType, cursor = null) {
  const ac = cursor ? `, after: "${cursor}"` : '';
  const oq = ownerType === 'org'
    ? `organization(login: "${PROJECT_OWNER}")`
    : `user(login: "${PROJECT_OWNER}")`;
  return `{
    ${oq} {
      projectV2(number: ${PROJECT_NUMBER}) {
        id title
        items(first: 100${ac}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
                ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
                ... on ProjectV2ItemFieldIterationValue { title startDate duration field { ... on ProjectV2IterationField { name } } }
                ... on ProjectV2ItemFieldUserValue { users(first: 5) { nodes { login } } field { ... on ProjectV2Field { name } } }
              }
            }
            content {
              ... on Issue {
                title state
                assignees(first: 5) { nodes { login } }
                labels(first: 10)   { nodes { name  } }
                createdAt closedAt
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

async function ghQuery(query) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `bearer ${GH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || JSON.stringify(json.errors));
  if (!json.data)  throw new Error('GitHub no devolvio datos.');
  return json.data;
}

async function fetchAllItems() {
  let allItems = [], cursor = null, hasNext = true, projectTitle = '';
  while (hasNext) {
    const data    = await ghQuery(buildQuery(PROJECT_OWNER_TYPE, cursor));
    const owner   = data.organization || data.user;
    const project = owner?.projectV2;
    if (!project) throw new Error(`No se encontro Project #${PROJECT_NUMBER}`);
    projectTitle  = project.title;
    const page    = project.items;
    allItems      = allItems.concat(page.nodes);
    hasNext       = page.pageInfo.hasNextPage;
    cursor        = page.pageInfo.endCursor;
    console.log(`  -> ${allItems.length} items extraidos`);
  }
  return { items: allItems, projectTitle };
}

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
    if (fv.users     !== undefined) fields[fname]             = fv.users.nodes.map(u => u.login).join(', ');
  }
  const content   = node.content || {};
  const assignees = content.assignees?.nodes?.map(a => a.login) || [];
  const rawLabels = content.labels?.nodes?.map(l => l.name)    || [];
  const { severity, entities, activityType } = classifyLabels(rawLabels);
  return {
    status:       fields['Status']        || 'No definido',
    hrs:          Number(fields['Estimate (hrs)'] || fields['Estimate'] || 0),
    iterStartDate:fields['Iteracion__start'] || fields['Iteration__start'] || fields['Iteración__start'] || null,
    refDate:      fields['Reported Date'] || content.createdAt || null,
    assignees:    assignees.length    ? assignees    : ['Sin asignar'],
    severity:     severity.length     ? severity     : [],
    activityType: activityType.length ? activityType : ['Sin tipo'],
  };
}

function analyzeItems(rawItems) {
  const now   = new Date();
  const start = new Date(`${now.getFullYear()}-01-01T00:00:00`);
  const items = rawItems.map(parseItem).filter(i => {
    const d = i.refDate ? new Date(i.refDate) : null;
    return !d || d >= start;
  });

  function statusIndicator(list) {
    const map = {};
    for (const s of ALL_STATUSES) map[s] = { count: 0, hrs: 0 };
    map['Otros'] = { count: 0, hrs: 0 };
    for (const item of list) {
      const key = ALL_STATUSES.includes(item.status) ? item.status : 'Otros';
      map[key].count++;
      map[key].hrs += Number(item.hrs) || 0;
    }
    return map;
  }

  function groupBy(list, key) {
    const map = {};
    for (const item of list) {
      const vals = Array.isArray(item[key]) ? item[key] : [item[key]];
      for (const v of vals) {
        if (!map[v]) map[v] = { count: 0, hrs: 0 };
        map[v].count++;
        map[v].hrs += Number(item.hrs) || 0;
      }
    }
    return map;
  }

  function severityCount(list) {
    const map = { S1: 0, S2: 0, S3: 0 };
    for (const item of list)
      for (const s of item.severity)
        if (map[s] !== undefined) map[s]++;
    return map;
  }

  const weekItems = items.filter(i => isThisWeek(i.iterStartDate));
  const weekRange = getWeekRange();

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

function fmt(count, hrs) {
  return `*${count}* tareas · *${hrs}h*`;
}

function formatSlackReport(projectTitle, s) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const ms      = s.weekRange.monday.toLocaleDateString('es-MX', { day:'2-digit', month:'short' });
  const ss      = s.weekRange.sunday.toLocaleDateString('es-MX', { day:'2-digit', month:'short' });
  const ys      = s.yearByStatus;
  const ws      = s.weekByStatus;
  const sev     = s.yearSeverity;
  const sevW    = s.weekSeverity;
  const actRows = Object.entries(s.weekByActivity).filter(([k]) => k !== 'Sin tipo').sort((a,b) => b[1].hrs - a[1].hrs).map(([n,d]) => `  • ${n}: *${d.count}* tareas · *${d.hrs}h*`).join('\n');
  const asgRows = Object.entries(s.weekByAssignee).sort((a,b) => b[1].hrs - a[1].hrs).map(([n,d]) => `  • *${n}*: ${d.count} tareas · ${d.hrs}h`).join('\n');
  const alerts = [];
  if (sev.S1 > 0) alerts.push(`🔴 *${sev.S1} S1* en acumulado.`);
  if (sevW.S1 > 0) alerts.push(`🔴 *${sevW.S1} S1 esta semana* — escalar.`);
  const dp = s.yearTotal ? Math.round((ys[STATUS.DONE].count / s.yearTotal) * 100) : 0;
  if (dp < 50) alerts.push(`⚠️ Completitud anual *${dp}%* — revisar avance.`);
  const al = alerts.length ? `*Alertas*\n${alerts.join('\n')}` : '✅ Sin alertas criticas.';
  return [
    `📊 *Reporte de Productividad — ${REPORT_TITLE}*`,
    `_${dateStr} · GitHub Project #${PROJECT_NUMBER} · Esfuerzo en horas_`,
    `_Proyecto: ${projectTitle}_`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 *INDICADORES GLOBALES ${now.getFullYear()} · ${s.yearTotal} tareas · ${s.yearHrs}h*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  📋 Backlog:              ${fmt(ys[STATUS.BACKLOG].count, ys[STATUS.BACKLOG].hrs)}`,
    `  📌 Sprint Backlog:       ${fmt(ys[STATUS.SPRINT_BACKLOG].count, ys[STATUS.SPRINT_BACKLOG].hrs)}`,
    `  🔄 In Progress:          ${fmt(ys[STATUS.IN_PROGRESS].count, ys[STATUS.IN_PROGRESS].hrs)}`,
    `  🔍 In Review:            ${fmt(ys[STATUS.IN_REVIEW].count, ys[STATUS.IN_REVIEW].hrs)}`,
    `  🧪 Ready to Test:        ${fmt(ys[STATUS.READY_TEST].count, ys[STATUS.READY_TEST].hrs)}`,
    `  🚀 Ready for Production: ${fmt(ys[STATUS.READY_PROD].count, ys[STATUS.READY_PROD].hrs)}`,
    `  ✅ Done:                 ${fmt(ys[STATUS.DONE].count, ys[STATUS.DONE].hrs)}`,
    `  Severidades año: 🔴 S1: ${sev.S1}  🟡 S2: ${sev.S2}  🟢 S3: ${sev.S3}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🗓 *SEMANA CORRIENTE · ${ms} – ${ss} · ${s.weekTotal} tareas · ${s.weekHrs}h*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  📌 Sprint Backlog:       ${fmt(ws[STATUS.SPRINT_BACKLOG].count, ws[STATUS.SPRINT_BACKLOG].hrs)}`,
    `  🔄 In Progress:          ${fmt(ws[STATUS.IN_PROGRESS].count, ws[STATUS.IN_PROGRESS].hrs)}`,
    `  🧪 Ready to Test:        ${fmt(ws[STATUS.READY_TEST].count, ws[STATUS.READY_TEST].hrs)}`,
    `  🚀 Ready for Production: ${fmt(ws[STATUS.READY_PROD].count, ws[STATUS.READY_PROD].hrs)}`,
    `  ✅ Done:                 ${fmt(ws[STATUS.DONE].count, ws[STATUS.DONE].hrs)}`,
    `  Severidades semana: 🔴 S1: ${sevW.S1}  🟡 S2: ${sevW.S2}  🟢 S3: ${sevW.S3}`,
    ``,
    `*Por tipo de actividad — semana*`,
    actRows || `  Sin actividades esta semana`,
    ``,
    `*Por responsable — semana*`,
    asgRows || `  Sin asignaciones esta semana`,
    ``,
    al,
    ``,
    `_Fuente: GitHub Project #${PROJECT_NUMBER} · Generado automaticamente · ${REPORT_TITLE}_`,
  ].join('\n');
}

async function sendToSlack(text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text, mrkdwn: true }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
  return json;
}

async function main() {
  console.log(`\n🚀 Iniciando reporte — ${REPORT_TITLE}`);
  try {
    console.log('📥 Extrayendo items...');
    const { items, projectTitle } = await fetchAllItems();
    console.log(`   ✓ ${items.length} items · "${projectTitle}"`);
    console.log('🔢 Analizando...');
    const stats = analyzeItems(items);
    console.log(`   ✓ Año: ${stats.yearTotal} | Semana: ${stats.weekTotal}`);
    const message = formatSlackReport(projectTitle, stats);
    console.log('📤 Enviando a Slack...');
    await sendToSlack(message);
    console.log('✅ Completado.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    try { await sendToSlack(`❌ *Error — ${REPORT_TITLE}*\n\`${err.message}\``); } catch (_) {}
    process.exit(1);
  }
}

main();
// v4 - domingo, 17 de mayo de 2026, 19:57:07 CST
