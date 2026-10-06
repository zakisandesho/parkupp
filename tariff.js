// Price calculator for Uppsala parking. Works in the browser (window.Tariff) and in Node (require).
//
// A tariff looks like:
//   { rules: [{ days: ["wd","sat","sun"], from: 8, to: 18, price: 20, per: 60,
//               firstHours?: 2, after?: 35, block?: true }],
//     cap24h?: 220, capByDay?: { wd: 52, sat: 21, sun: 21 }, freeMin?: 60, maxStayMin?: 240 }
//
// Day types follow Swedish sign rules: "wd" = Mon–Fri, "sat" = Saturday or the day before a
// public holiday (times in parentheses), "sun" = Sunday or public holiday (red times).
// per = minutes the price covers. block: true means "per started period" (garages);
// otherwise the price is charged per minute, like the parking apps do.
(function (root) {
  function easter(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  function key(d) {
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  // The Saturday that falls within [month/day, +6 days]
  function saturdayFrom(year, month, day) {
    const d = new Date(year, month - 1, day);
    return addDays(d, (6 - d.getDay() + 7) % 7);
  }

  const holidayCache = {};
  function holidays(year) {
    if (holidayCache[year]) return holidayCache[year];
    const e = easter(year);
    const midsummer = saturdayFrom(year, 6, 20);
    const days = [
      new Date(year, 0, 1), new Date(year, 0, 6), addDays(e, -2), e, addDays(e, 1),
      new Date(year, 4, 1), addDays(e, 39), addDays(e, 49), new Date(year, 5, 6),
      midsummer, saturdayFrom(year, 10, 31), new Date(year, 11, 25), new Date(year, 11, 26),
      // Midsummer Eve, Christmas Eve and New Year's Eve count as public holidays in traffic rules
      addDays(midsummer, -1), new Date(year, 11, 24), new Date(year, 11, 31),
    ];
    return (holidayCache[year] = new Set(days.map(key)));
  }

  function isHoliday(d) {
    return holidays(d.getFullYear()).has(key(d));
  }

  function dayType(d) {
    if (d.getDay() === 0 || isHoliday(d)) return "sun";
    if (d.getDay() === 6 || isHoliday(addDays(d, 1))) return "sat";
    return "wd";
  }

  function inWindow(hourFloat, from, to) {
    if (from === to) return true;
    if (from < to) return hourFloat >= from && hourFloat < to;
    return hourFloat >= from || hourFloat < to; // wraps past midnight
  }

  function activeRule(tariff, t) {
    const type = dayType(t);
    const h = t.getHours() + t.getMinutes() / 60;
    return tariff.rules.find((r) => r.days.includes(type) && inWindow(h, r.from, r.to)) || null;
  }

  // Is any minute of the stay inside one of the windows? (used for time limits and opening hours)
  function overlaps(windows, start, minutes) {
    for (let m = 0; m < minutes; m += 5) {
      const t = new Date(start.getTime() + m * 60000);
      const type = dayType(t);
      const h = t.getHours() + t.getMinutes() / 60;
      if (windows.some((w) => w.days.includes(type) && inWindow(h, w.from, w.to))) return true;
    }
    return false;
  }

  // Returns { cost, allowed, reasons: [] }
  function calculate(tariff, start, minutes, limit) {
    const reasons = [];
    if (tariff.maxStayMin && minutes > tariff.maxStayMin) {
      reasons.push("Max parkeringstid " + formatDuration(tariff.maxStayMin));
    }
    if (limit && minutes > limit.maxMin && (!limit.windows || overlaps(limit.windows, start, minutes))) {
      reasons.push("Tidsbegränsning: " + limit.text);
    }

    const charges = []; // charge per minute index
    const tierUsed = new Map();
    let blockUntil = -1;
    for (let m = 0; m < minutes; m++) {
      charges.push(0);
      if (tariff.freeMin && m < tariff.freeMin) continue;
      const t = new Date(start.getTime() + m * 60000);
      const rule = activeRule(tariff, t);
      if (!rule) continue;
      if (rule.block) {
        if (m >= blockUntil) {
          charges[m] = rule.price;
          blockUntil = m + rule.per;
        }
        continue;
      }
      blockUntil = -1;
      let price = rule.price;
      if (rule.firstHours) {
        // "first 2 h" counts from the start of the stay, across weekday/Saturday rules
        const tierKey = rule.price + "/" + rule.firstHours + "/" + rule.after;
        const used = tierUsed.get(tierKey) || 0;
        if (used >= rule.firstHours * 60) price = rule.after;
        tierUsed.set(tierKey, used + 1);
      }
      charges[m] = price / rule.per;
    }

    let cost = 0;
    if (tariff.capByDay) {
      // cap per calendar day
      const perDay = new Map();
      charges.forEach((c, m) => {
        const t = new Date(start.getTime() + m * 60000);
        const k = key(t);
        const e = perDay.get(k) || { sum: 0, cap: tariff.capByDay[dayType(t)] };
        e.sum += c;
        perDay.set(k, e);
      });
      perDay.forEach((e) => (cost += e.cap != null ? Math.min(e.sum, e.cap) : e.sum));
    } else if (tariff.cap24h) {
      for (let i = 0; i < charges.length; i += 1440) {
        const sum = charges.slice(i, i + 1440).reduce((a, b) => a + b, 0);
        cost += Math.min(sum, tariff.cap24h);
      }
    } else {
      cost = charges.reduce((a, b) => a + b, 0);
    }
    return { cost: Math.round(cost), allowed: reasons.length === 0, reasons };
  }

  function formatDuration(min) {
    if (min % 1440 === 0) return min / 1440 + " dygn";
    if (min % 60 === 0) return min / 60 + " h";
    return min + " min";
  }

  const api = { calculate, dayType, isHoliday, overlaps, formatDuration };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Tariff = api;
})(this);
