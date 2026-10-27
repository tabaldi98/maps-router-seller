/* Horário de funcionamento.
 * Todas as fontes viram uma grade semanal: lista de [diaDaSemana (0=dom), inícioMin, fimMin], em minutos
 * desde a meia-noite daquele dia. fimMin pode passar de 1440 (fecha depois da meia-noite).
 * null = horário desconhecido; [] = informado e fechado a semana toda.
 */
'use strict';

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const SEMANA = 7 * 1440;
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const hhmm = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// TomTom (openingHours=nextSevenDays): intervalos com data e hora local dos próximos 7 dias.
function hoursFromTomTom(oh) {
  if (!oh || !Array.isArray(oh.timeRanges)) return null;
  const out = [];
  for (const { startTime: a, endTime: b } of oh.timeRanges) {
    if (!a || !b) continue;
    const day = new Date(a.date + 'T00:00:00');
    const startMs = new Date(`${a.date}T${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')}:00`);
    const endMs = new Date(`${b.date}T${String(b.hour).padStart(2, '0')}:${String(b.minute).padStart(2, '0')}:00`);
    const s = a.hour * 60 + a.minute;
    const e = s + Math.round((endMs - startMs) / 60000);
    if (e > s && !out.some(([d, s2]) => d === day.getDay() && s2 === s)) out.push([day.getDay(), s, e]);
  }
  return out;
}

// OpenStreetMap (opening_hours), formatos mais comuns: "Mo-Fr 11:00-15:00,18:00-23:00; Sa 11:00-15:00; Su off",
// "24/7", "11:00-23:00". Feriados (PH) são ignorados. Formato que não entendemos → desconhecido.
const OSM_DIA = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
function hoursFromOsm(s) {
  if (!s || typeof s !== 'string') return null;
  s = s.trim();
  if (s === '24/7') return [0, 1, 2, 3, 4, 5, 6].map((d) => [d, 0, 1440]);
  let out = [];
  for (let rule of s.split(';')) {
    rule = rule.trim();
    if (!rule || /^(PH|SH)\b/i.test(rule)) continue;
    const m = rule.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(.*)$/i);
    let days = [0, 1, 2, 3, 4, 5, 6];
    if (m[1]) {
      days = [];
      for (const part of m[1].split(',')) {
        const [a, b] = part.split('-').map((x) => OSM_DIA[x.trim().toLowerCase()]);
        if (b === undefined) days.push(a);
        else for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b) break; }
      }
    }
    const times = m[2].replace(/^,/, '').trim();
    out = out.filter(([d]) => !days.includes(d));   // regra posterior vale sobre a anterior
    if (/^(off|closed)$/i.test(times)) continue;
    const ranges = times.split(',').map((t) => t.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\+?$/));
    if (!times || ranges.some((r) => !r)) return null;
    for (const d of days) {
      for (const r of ranges) {
        const a = +r[1] * 60 + +r[2];
        let b = +r[3] * 60 + +r[4];
        if (b <= a) b += 1440;
        out.push([d, a, b]);
      }
    }
  }
  return out.length ? out : null;
}

// Google Maps (coluna open_hours do scraper): {"Monday": ["11 am–3 pm", "6–11 pm"], "Sunday": ["Closed"]}.
const G_DIA = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domingo: 0, 'segunda-feira': 1, 'terca-feira': 2, 'quarta-feira': 3, 'quinta-feira': 4, 'sexta-feira': 5, sabado: 6,
};
function hoursFromGoogle(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return null; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  // "3 pm", "11:30 am", "18:00". Sem am/pm usa o do fim do intervalo ("6–11 pm" = 18h às 23h).
  const time = (t, mer) => {
    const m = fold(t).match(/(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
    if (!m) return null;
    const own = m[3]?.[0];
    const use = own || mer;
    let h = +m[1];
    if (use === 'p' && h < 12) h += 12;
    if (use === 'a' && h === 12) h = 0;
    return { min: h * 60 + (+m[2] || 0), mer: own };
  };
  const out = [];
  let known = false;
  for (const [day, list] of Object.entries(o)) {
    const d = G_DIA[fold(day).trim()];
    if (d === undefined) continue;
    for (const item of [].concat(list)) {
      const t = fold(item);
      known = true;
      if (/closed|fechado/.test(t)) continue;
      if (/24 hours|24 horas/.test(t)) { out.push([d, 0, 1440]); continue; }
      const [a, b] = t.split(/\s*(?:–|-|\bto\b|\bate\b|\bas\b)\s*/);
      if (!a || !b) return null;
      const end = time(b);
      let start = end && time(a, end.mer);
      if (!start) return null;
      if (!start.mer && end.mer && start.min > end.min) start = time(a, 'a');   // "11–3 pm" = 11h às 15h
      out.push([d, start.min, end.min <= start.min ? end.min + 1440 : end.min]);
    }
  }
  return known ? out : null;
}

// Minuto da semana de uma data (0 = domingo 00:00).
const minOfWeek = (date) => date.getDay() * 1440 + date.getHours() * 60 + date.getMinutes();

// Intervalos em minutos da semana, com cópias uma semana antes e depois (para quem vira a noite de sáb para dom).
function weekIntervals(hours) {
  const base = hours.map(([d, s, e]) => [d * 1440 + s, d * 1440 + e]);
  return [...base.map(([s, e]) => [s - SEMANA, e - SEMANA]), ...base, ...base.map(([s, e]) => [s + SEMANA, e + SEMANA])];
}

// true/false, ou null se o horário é desconhecido.
function openAt(hours, date) {
  if (!hours) return null;
  const w = minOfWeek(date);
  return weekIntervals(hours).some(([s, e]) => s <= w && w < e);
}

// Texto curto para a lista: "🟢 Aberto · fecha 23:00", "🔴 Fechado · abre qua 11:00".
function describeHours(hours, date) {
  if (!hours) return '';
  const w = minOfWeek(date);
  const iv = weekIntervals(hours);
  const cur = iv.filter(([s, e]) => s <= w && w < e).sort((a, b) => b[1] - a[1])[0];
  if (cur) return `🟢 Aberto · fecha ${hhmm(cur[1])}`;
  const next = iv.filter(([s]) => s > w).sort((a, b) => a[0] - b[0])[0];
  if (!next) return '🔴 Fechado a semana toda';
  const sameDay = Math.floor(next[0] / 1440) === Math.floor(w / 1440);
  const dia = sameDay ? '' : DIAS[((Math.floor(next[0] / 1440) % 7) + 7) % 7] + ' ';
  return `🔴 Fechado · abre ${dia}${hhmm(next[0])}`;
}

// "11:00–15:00, 18:00–23:00" do dia da data (ou "fechado").
function hoursOfDay(hours, date) {
  if (!hours) return '';
  const d = date.getDay();
  const list = hours.filter(([dd]) => dd === d).sort((a, b) => a[1] - b[1]);
  return list.length ? list.map(([, s, e]) => `${hhmm(s)}–${hhmm(e)}`).join(', ') : 'fechado';
}
