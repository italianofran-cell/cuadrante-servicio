// Tests automáticos de las reglas del generador de cuadrantes.
// Carga index.html en un DOM simulado (sin Supabase: usa localStorage) y
// ejercita buildWeekData comprobando todas las reglas de reparto.
//
// Uso: npm test

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

// Quita el script externo de Supabase: sin él la app arranca en modo localStorage
html = html.replace(/<script src="https:[^"]*supabase[^"]*"><\/script>\s*/g, '');

// Extrae el script inline (el único <script> sin src)
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('No se encontró el script inline en index.html'); process.exit(1); }
const appScript = m[1];

const dom = new JSDOM(html.replace(m[0], ''), {
  url: 'https://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const w = dom.window;
w.alert = () => {};
w.confirm = () => true;

// Evalúa la app y expone ganchos de test (mismo ámbito léxico que las variables `let` del script)
w.eval(appScript + `
;window.__t = {
  buildWeekData, getISOWeek, isoDate, workingSetsForWeek, normalizeUnitName,
  agentState, isAbsentOn,
  getState(){ return {UNIT_DEFS, unitPriority, habilitadosSala, habilitadosLuna, fijosPatrimonio,
    G43_RANGO, G52_RANGO, G2, ALL_RANGO_IDS, DAY_NAMES, TEMP_RULES_CUTOFF, UNIDADES_LIMITADOS}; },
  set(o){
    if(o.agentNames !== undefined) agentNames = o.agentNames;
    if(o.incompatiblePairs !== undefined) incompatiblePairs = o.incompatiblePairs;
    if(o.limitadosFisicos !== undefined) limitadosFisicos = o.limitadosFisicos;
    if(o.agentStatus !== undefined) agentStatus = o.agentStatus;
    if(o.preferredPairs !== undefined) preferredPairs = o.preferredPairs;
    if(o.histUnitCounts !== undefined) histUnitCounts = o.histUnitCounts;
    if(o.fijosPatrimonio !== undefined) fijosPatrimonio = o.fijosPatrimonio;
  }
};`);

await new Promise(r => setTimeout(r, 100)); // deja terminar el arranque asíncrono
const t = w.__t;
const S = t.getState();

// ---------- utilidades ----------
let failures = 0, checks = 0;
function fail(msg){ failures++; console.error('  ✗ ' + msg); }
function ok(cond, msg){ checks++; if(!cond) fail(msg); }
function resetConfig(){
  t.set({ agentNames: {}, incompatiblePairs: [], limitadosFisicos: [], agentStatus: {},
          preferredPairs: [], histUnitCounts: {} });
}
function mkWeek(mondayStr){
  const monday = new Date(mondayStr + 'T00:00:00');
  const weekNum = t.getISOWeek(monday);
  const weekType = ((weekNum - 29) % 2 + 2) % 2 === 0 ? 'A' : 'B';
  return t.buildWeekData(monday, weekType);
}
function serviceDays(week){ return week.days.filter(d => !d.skip); }
function unitsOf(day){ return day.assignments || []; }
function agentsInUnit(a){ return a.agents.filter(x => x !== 'SIN CUBRIR'); }
const dkOf = u => { const n = t.normalizeUnitName(u); return (S.UNIT_DEFS[n] && S.UNIT_DEFS[n].unitKey) || n; };

const SEMANA_B = '2026-07-20'; // fase B: Lun, Mié, Jue, Dom (antes del corte)
const SEMANA_A = '2026-07-27'; // fase A: Mar, Vie, Sáb (antes del corte)
const SEMANA_POST = '2026-09-07'; // después del corte del 01/09
const REPS = 8; // repeticiones por escenario (el reparto es aleatorio)

// ---------- 1. Coherencia básica: nadie dos veces el mismo día, sin huecos con plantilla completa ----------
console.log('1. Coherencia básica (plantilla completa)');
resetConfig();
for (const monday of [SEMANA_B, SEMANA_A]) for (let i = 0; i < REPS; i++){
  const wk = mkWeek(monday);
  for (const d of serviceDays(wk)){
    const seen = new Set();
    for (const a of unitsOf(d)) for (const ag of agentsInUnit(a)){
      ok(!seen.has(ag), `${monday} ${d.dayName}: ${ag} asignado dos veces`);
      seen.add(ag);
    }
    for (const p of d.pico || []){
      ok(!seen.has(p), `${monday} ${d.dayName}: ${p} en unidad y en PICO`);
      seen.add(p);
    }
    for (const a of unitsOf(d))
      ok(!a.agents.includes('SIN CUBRIR'), `${monday} ${d.dayName}: ${a.unit} SIN CUBRIR con plantilla completa`);
  }
}

// ---------- 2. Regla del 724: siempre ALMUDI hasta el corte, desaparece después ----------
console.log('2. Regla del 724 (solo ALMUDI hasta 01/09, luego desaparece)');
resetConfig();
for (let i = 0; i < REPS; i++){
  for (const monday of [SEMANA_B, SEMANA_A]){
    const wk = mkWeek(monday);
    for (const d of serviceDays(wk)){
      const almudi = unitsOf(d).find(a => a.unit === 'ALMUDI');
      ok(almudi && almudi.agents[0] === '724', `${monday} ${d.dayName}: ALMUDI debería ser del 724, es ${almudi && almudi.agents[0]}`);
      for (const a of unitsOf(d)) if (a.unit !== 'ALMUDI')
        ok(!a.agents.includes('724'), `${monday} ${d.dayName}: 724 en ${a.unit}`);
    }
  }
  const post = mkWeek(SEMANA_POST);
  for (const d of serviceDays(post)){
    for (const a of unitsOf(d)) ok(!a.agents.includes('724'), `post-corte: 724 en ${a.unit}`);
    ok(!(d.pico || []).includes('724'), 'post-corte: 724 en PICO');
  }
}

// ---------- 3. Habilitados: SALA 1 (sin 791), SALA 2 / V CH, LUNA, PUERTA (regla temporal) ----------
console.log('3. Habilitados de SALA, LUNA y PUERTA');
resetConfig();
for (let i = 0; i < REPS; i++) for (const monday of [SEMANA_B, SEMANA_A]){
  const wk = mkWeek(monday);
  for (const d of serviceDays(wk)) for (const a of unitsOf(d)){
    const un = t.normalizeUnitName(a.unit);
    for (const ag of agentsInUnit(a)){
      if (un === 'SALA 1'){
        ok(S.habilitadosSala.includes(ag), `${d.dayName}: ${ag} en SALA 1 sin estar habilitado`);
        ok(ag !== '791', `${d.dayName}: 791 en SALA 1 (prohibido)`);
      }
      if (un === 'SALA 2') ok(S.habilitadosSala.includes(ag), `${d.dayName}: ${ag} en ${a.unit} sin estar habilitado`);
      if (un === 'LUNA') ok(S.habilitadosLuna.includes(ag), `${d.dayName}: ${ag} en LUNA sin estar habilitado`);
      if (un === 'PUERTA') ok(S.habilitadosSala.includes(ag), `${d.dayName}: PUERTA con ${ag} (regla temporal: solo habilitados SALA)`);
    }
  }
}

// ---------- 4. Parejas incompatibles ----------
console.log('4. Parejas incompatibles nunca juntas en unidad');
resetConfig();
t.set({ incompatiblePairs: [
  {a:'914', b:'979', days:[], always:true},
  {a:'864', b:'908', days:['Miércoles','Jueves'], always:false}
]});
for (let i = 0; i < REPS; i++) for (const monday of [SEMANA_B, SEMANA_A]){
  const wk = mkWeek(monday);
  for (const d of serviceDays(wk)) for (const a of unitsOf(d)){
    const ags = agentsInUnit(a);
    ok(!(ags.includes('914') && ags.includes('979')), `${d.dayName}: 914+979 juntos en ${a.unit}`);
    if (d.dayName === 'Miércoles' || d.dayName === 'Jueves')
      ok(!(ags.includes('864') && ags.includes('908')), `${d.dayName}: 864+908 juntos en ${a.unit}`);
  }
}

// ---------- 5. Limitados físicos ----------
console.log('5. Limitados físicos: solo Patrimonio o Sala');
resetConfig();
t.set({ limitadosFisicos: ['642', '1043'] });
for (let i = 0; i < REPS; i++) for (const monday of [SEMANA_B, SEMANA_A, SEMANA_POST]){
  const wk = mkWeek(monday);
  for (const d of serviceDays(wk)) for (const a of unitsOf(d)){
    const un = t.normalizeUnitName(a.unit);
    for (const lim of ['642', '1043'])
      if (a.agents.includes(lim))
        ok(S.UNIDADES_LIMITADOS.includes(un), `${d.dayName}: limitado ${lim} en ${a.unit}`);
  }
}

// ---------- 6. Victoria y Virginia nunca a Patrimonio ----------
console.log('6. Victoria/Virginia nunca en Ayuntamiento, Almudí ni Puerta');
resetConfig();
t.set({ agentNames: {'1015':'Victoria', '1058':'virginia lópez'} });
for (let i = 0; i < REPS; i++) for (const monday of [SEMANA_B, SEMANA_A]){
  const wk = mkWeek(monday);
  for (const d of serviceDays(wk)) for (const a of unitsOf(d)){
    const un = t.normalizeUnitName(a.unit);
    if (un === 'AYUNTAMIENTO' || un === 'ALMUDI' || un === 'PUERTA'){
      ok(!a.agents.includes('1015'), `${d.dayName}: Victoria (1015) en ${a.unit}`);
      ok(!a.agents.includes('1058'), `${d.dayName}: Virginia (1058) en ${a.unit}`);
    }
  }
}

// ---------- 7. Ausencias con fechas, motivos e intervalos múltiples ----------
console.log('7. Ausencias por fechas (intervalos con motivo) aplicadas día a día');
resetConfig();
// 633 de BAJA desde el jueves 23/07; 914 de VACACIONES hasta el jueves 23/07;
// 669 con DOS intervalos: VACACIONES del 20 al 21 y AP del 23 al 25
t.set({ agentStatus: {
  '633': [{desde:'2026-07-23', vuelve:null, motivo:'BAJA'}],
  '914': [{desde:'2026-07-01', vuelve:'2026-07-23', motivo:'VACACIONES'}],
  '669': [
    {desde:'2026-07-20', vuelve:'2026-07-22', motivo:'VACACIONES'},
    {desde:'2026-07-23', vuelve:'2026-07-26', motivo:'AP'}
  ]
}});
for (let i = 0; i < REPS; i++){
  const wk = mkWeek(SEMANA_B); // Lun 20, Mié 22, Jue 23, Dom 26
  for (const d of serviceDays(wk)){
    const all = new Set();
    for (const a of unitsOf(d)) agentsInUnit(a).forEach(x => all.add(x));
    (d.pico || []).forEach(x => all.add(x));
    const antesDelJueves = d.date < '2026-07-23';
    ok(all.has('633') === antesDelJueves, `${d.dayName} (${d.date}): 633 ${antesDelJueves?'debería':'no debería'} trabajar`);
    ok(all.has('914') === !antesDelJueves, `${d.dayName} (${d.date}): 914 ${!antesDelJueves?'debería':'no debería'} trabajar`);
    // 669: ausente Lun (vacaciones) y Jue (AP); trabaja Mié y Dom
    const debe669 = (d.date === '2026-07-22' || d.date === '2026-07-26');
    ok(all.has('669') === debe669, `${d.dayName} (${d.date}): 669 ${debe669?'debería':'no debería'} trabajar (intervalos múltiples)`);
  }
}

// ---------- 8. Parejas preferentes juntas ----------
console.log('8. Parejas preferentes juntas los días marcados');
resetConfig();
t.set({ preferredPairs: [{a:'864', b:'1131', days:['Martes','Viernes']}] }); // ambos g52 (trabajan Mar/Vie en fase A)
for (let i = 0; i < REPS; i++){
  const wk = mkWeek(SEMANA_A);
  for (const d of serviceDays(wk)){
    if (d.dayName !== 'Martes' && d.dayName !== 'Viernes') continue;
    const juntos = unitsOf(d).some(a => a.agents.includes('864') && a.agents.includes('1131'));
    ok(juntos, `${d.dayName}: pareja preferente 864+1131 no está junta`);
  }
}

// ---------- 9. No repetir unidad en la semana (unidades sin restricción) ----------
console.log('9. Sin repeticiones en V10-V60; LUNA como máximo 1 repetición (capacidad justa)');
resetConfig();
for (let i = 0; i < REPS; i++) for (const monday of [SEMANA_B, SEMANA_A]){
  const wk = mkWeek(monday);
  const porAgente = {}; // agente -> {doneKey: veces}
  for (const d of serviceDays(wk)) for (const a of unitsOf(d)){
    const un = t.normalizeUnitName(a.unit);
    if (un === 'AYUNTAMIENTO' || un === 'ALMUDI') continue; // fijos: repiten por diseño
    const dk = dkOf(a.unit);
    for (const ag of agentsInUnit(a)){
      porAgente[ag] = porAgente[ag] || {};
      porAgente[ag][dk] = (porAgente[ag][dk] || 0) + 1;
    }
  }
  let repesLuna = 0;
  for (const [ag, m2] of Object.entries(porAgente)) for (const [dk, n] of Object.entries(m2)){
    if (dk === 'SALA' || dk === 'PUERTA') continue; // pocas plazas habilitadas: se acota en el test 10
    if (dk === 'LUNA'){ repesLuna += n - 1; continue; }
    ok(n <= 1, `${monday}: ${ag} repite ${dk} (${n} veces)`);
  }
  // LUNA tiene capacidad semanal justa (633 fijo en Ayuntamiento y 914/979 absorbidos por SALA
  // dejan ~8 habilitados útiles para 8 plazas en fase B): se toleran hasta 2 repeticiones
  ok(repesLuna <= 2, `${monday}: ${repesLuna} repeticiones de LUNA (máximo tolerado 2)`);
}

// ---------- 10. Repeticiones forzosas acotadas en SALA/PUERTA ----------
console.log('10. Repeticiones en SALA/PUERTA no superan el mínimo inevitable');
resetConfig();
for (const monday of [SEMANA_B, SEMANA_A]){
  const sets = t.workingSetsForWeek(mkWeek(monday).weekType);
  for (let i = 0; i < REPS; i++){
    const wk = mkWeek(monday);
    let salaSlots = 0;
    const personas = new Set();
    let repes = 0;
    const vistos = {};
    for (const d of serviceDays(wk)) for (const a of unitsOf(d)){
      const dk = dkOf(a.unit);
      if (dk !== 'SALA' && dk !== 'PUERTA') continue;
      for (const ag of agentsInUnit(a)){
        salaSlots++;
        personas.add(ag);
        vistos[ag + '|' + dk] = (vistos[ag + '|' + dk] || 0) + 1;
      }
    }
    repes = Object.values(vistos).filter(n => n > 1).reduce((s, n) => s + n - 1, 0);
    const habilitados = S.habilitadosSala.length;
    const margen = Math.max(0, salaSlots - habilitados) + 1;
    ok(repes <= margen, `${monday}: ${repes} repeticiones en SALA/PUERTA (máximo tolerado ${margen})`);
  }
}

// ---------- resumen ----------
console.log('');
if (failures){
  console.error(`RESULTADO: ${failures} fallo(s) de ${checks} comprobaciones`);
  process.exit(1);
} else {
  console.log(`RESULTADO: ✓ las ${checks} comprobaciones han pasado`);
}
