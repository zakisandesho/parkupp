// Private and regional car parks, entered by hand from operator websites.
// Kommun car parks (Centralgaraget, Kvarnen, Dansmästaren ...) come from kommun.js instead.
// Update `checked` whenever you re-verify an entry. approx: true = position is approximate.
const ALL = ["wd", "sat", "sun"];

window.OPERATORS = {
  kommun: { name: "Uppsala parkering (kommun)", pay: ["EasyPark", "Parkster", "Mobill", "ePARK", "SMS", "Pay machine"] },
  aimo: { name: "Aimo Park", pay: ["Aimo Park app", "Card", "Number-plate auto-pay"] },
  apcoa: { name: "Apcoa", pay: ["Apcoa Flow app"] },
  region: { name: "Region Uppsala", pay: ["SmartPark", "EasyPark", "Pay machine"] },
  smartpark: { name: "Smart Parkering (Akademiska Hus)", pay: ["SmartPark", "SMS", "EasyPark (+15% fee)"] },
  parkman: { name: "Parkman", pay: ["Number-plate payment (autopay.io)", "Pay machine"] },
};

window.CARPARKS = [
  {
    name: "City garage", address: "S:t Olofsgatan 21", lat: 59.8616, lon: 17.63726, operator: "aimo", kind: "garage",
    tariff: {
      rules: [
        { days: ["sun"], from: 11, to: 18, price: 30, per: 60, block: true },
        { days: ALL, from: 0, to: 0, price: 20, per: 20, block: true },
      ],
      cap24h: 300,
    },
    open: [{ days: ALL, from: 6, to: 22 }],
    priceText: "20 kr per started 20 min; Sun 11–18 30 kr/h; max 300 kr/24h",
    source: "https://aimopark.se/en/cities/uppsala/city-garage/", checked: "2026-10-06",
  },
  {
    name: "Plus garage", address: "Dragarbrunnsgatan 47", lat: 59.85798, lon: 17.64242, operator: "aimo", kind: "garage",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 35, per: 30, block: true }], cap24h: 310 },
    priceText: "35 kr per started 30 min; max 310 kr/24h",
    source: "https://aimopark.se/en/cities/uppsala/plus-garage/", checked: "2026-10-06",
  },
  {
    name: "P-hus Grimhild", address: "Dragarbrunnsgatan 66", lat: 59.85603, lon: 17.64627, operator: "aimo", kind: "garage",
    tariff: {
      rules: [
        { days: ["sun"], from: 11, to: 18, price: 30, per: 60, block: true },
        { days: ALL, from: 0, to: 0, price: 14, per: 15, block: true },
      ],
      cap24h: 240,
    },
    priceText: "14 kr per started 15 min; Sun 11–18 30 kr/h; night 18–09 150 kr; max 240 kr/24h",
    note: "Night ticket (18–09, 150 kr) not included in the calculation",
    source: "https://aimopark.se/en/cities/uppsala/p-hus-grimhild/", checked: "2026-10-06",
  },
  {
    name: "Stationsgatan 40 garage", address: "Stationsgatan 40", lat: 59.85698, lon: 17.65168, operator: "aimo", kind: "garage",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 16, per: 15, block: true }], cap24h: 265 },
    priceText: "16 kr per started 15 min; night 19–09 110 kr; max 265 kr/24h",
    note: "Night ticket (19–09, 110 kr) not included in the calculation",
    source: "https://aimopark.se/en/cities/uppsala/stationsgatan-40-garage/", checked: "2026-10-06",
  },
  {
    name: "Saluhallen", address: "Vattugränd 1", lat: 59.85889, lon: 17.63358, operator: "aimo", kind: "lot",
    tariff: {
      rules: [
        { days: ALL, from: 9, to: 19, price: 23, per: 20, block: true },
        { days: ALL, from: 19, to: 9, price: 4, per: 20, block: true },
      ],
    },
    priceText: "09–19: 23 kr per started 20 min; other times 4 kr per started 20 min",
    source: "https://aimopark.se/en/cities/uppsala/saluhallen/", checked: "2026-10-06",
  },
  {
    name: "Observatorieparken", address: "Kyrkogårdsgatan 6", lat: 59.85854, lon: 17.6215, operator: "aimo", kind: "lot",
    tariff: {
      rules: [
        { days: ["wd"], from: 0, to: 0, price: 12, per: 60 },
        { days: ["sat", "sun"], from: 0, to: 0, price: 7, per: 60 },
      ],
      capByDay: { wd: 52, sat: 21, sun: 21 },
    },
    priceText: "Weekdays 12 kr/h, max 52 kr; other days 7 kr/h, max 21 kr",
    source: "https://aimopark.se/en/cities/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Väktargatan 2", address: "Väktargatan 2D", lat: 59.86882, lon: 17.64413, operator: "aimo", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 11, per: 60 }], cap24h: 75 },
    priceText: "11 kr/h; max 75 kr/24h",
    source: "https://aimopark.se/en/cities/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Torgny Segerstedts allé 2", address: "Torgny Segerstedts allé 2", lat: 59.83119, lon: 17.63339, operator: "aimo", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 25, per: 60 }] },
    priceText: "25 kr/h",
    source: "https://aimopark.se/en/cities/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Badhusgaraget", address: "S:t Persgatan 6", lat: 59.85929, lon: 17.63709, operator: "apcoa", kind: "garage",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 45, per: 60, block: true }], cap24h: 180 },
    priceText: "45 kr per started hour; 180 kr/day",
    source: "https://www.apcoa.se/parkering-i/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Lumi garaget", address: "Dragarbrunnsgatan 79", lat: 59.8542, lon: 17.64888, operator: "apcoa", kind: "garage",
    tariff: {
      rules: [
        { days: ALL, from: 7, to: 17, price: 40, per: 60 },
        { days: ALL, from: 17, to: 7, price: 25, per: 60 },
      ],
    },
    priceText: "07–17 40 kr/h, 17–07 25 kr/h; day ticket 180 kr (07–17), evening ticket 100 kr (17–07)",
    note: "Day/evening tickets not included in the calculation",
    source: "https://www.apcoa.se/parkering-i/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Kungshörnet", address: "Kungsgatan 107–115", lat: 59.84573, lon: 17.66569, operator: "apcoa", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 12, per: 60 }], freeMin: 60 },
    priceText: "First hour free, then 12 kr/h",
    source: "https://www.apcoa.se/parkering-i/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Kungsporten", address: "Kungsängsvägen 19–31", lat: 59.84715, lon: 17.67013, operator: "apcoa", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 15, per: 60 }], freeMin: 60, cap24h: 70 },
    priceText: "First hour free, then 15 kr/h; max 70 kr/24h",
    source: "https://www.apcoa.se/parkering-i/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Kungsgatan 70", address: "Kungsgatan 70", lat: 59.85049, lon: 17.6588, operator: "apcoa", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 12, per: 60 }] },
    priceText: "12 kr/h; 220 kr/week",
    source: "https://www.apcoa.se/parkering-i/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Bolandsgatan 16", address: "Bolandsgatan 16", lat: 59.85375, lon: 17.68202, operator: "apcoa", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 10, per: 60 }], cap24h: 50 },
    priceText: "10 kr/h; max 50 kr/24h",
    source: "https://www.apcoa.se/parkering-i/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Uppsala Business Park", address: "Rapsgatan", lat: 59.85197, lon: 17.70265, operator: "apcoa", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 25, per: 60 }], freeMin: 120 },
    priceText: "First 2 h free, then 25 kr/h; 50 kr for 10 h (08–18)",
    note: "10-hour ticket (50 kr) not included in the calculation",
    source: "https://www.apcoa.se/parkering-i/uppsala/", checked: "2026-10-06",
  },
  {
    name: "Akademiska sjukhuset – parking garage (north)", address: "Akademiska sjukhuset", lat: 59.85151, lon: 17.6406,
    operator: "region", kind: "lot",
    tariff: {
      rules: [
        { days: ALL, from: 6, to: 18, price: 20, per: 60 },
        { days: ALL, from: 18, to: 24, price: 10, per: 60 },
      ],
      cap24h: 80,
    },
    priceText: "06–18 20 kr/h, 18–24 10 kr/h, 00–06 free; max 80 kr/24h",
    source: "https://www.akademiska.se/besoka-sjukhuset/hitta-till-sjukhuset/parkering/", checked: "2026-10-06",
  },
  {
    name: "Akademiska sjukhuset – parking garage (entrance 78–79)", address: "Akademiska sjukhuset", lat: 59.84873, lon: 17.64193,
    operator: "region", kind: "lot",
    tariff: {
      rules: [
        { days: ALL, from: 6, to: 18, price: 20, per: 60 },
        { days: ALL, from: 18, to: 24, price: 10, per: 60 },
      ],
      cap24h: 80,
    },
    priceText: "06–18 20 kr/h, 18–24 10 kr/h, 00–06 free; max 80 kr/24h",
    source: "https://www.akademiska.se/besoka-sjukhuset/hitta-till-sjukhuset/parkering/", checked: "2026-10-06",
  },
  {
    name: "Akademiska sjukhuset – emergency dept (entrance 60–62)", address: "Akademiska sjukhuset", lat: 59.8487, lon: 17.6403,
    approx: true, operator: "region", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 31, per: 60 }], cap24h: 225 },
    priceText: "31 kr/h all hours; max 225 kr/24h",
    source: "https://www.akademiska.se/besoka-sjukhuset/hitta-till-sjukhuset/parkering/", checked: "2026-10-06",
  },
  {
    name: "Campus BMC / Ångström", address: "Husargatan", lat: 59.8422, lon: 17.63768, operator: "smartpark", kind: "lot",
    tariff: {
      rules: [
        { days: ALL, from: 6, to: 18, price: 20, per: 60 },
        { days: ALL, from: 18, to: 6, price: 10, per: 60 },
      ],
    },
    priceText: "06–18 20 kr/h, 18–06 10 kr/h; 80 kr for 15 h",
    note: "15-hour ticket (80 kr) not included in the calculation",
    source: "https://www.uu.se/campus/biomedicinskt-centrum/besok-oss/parkering", checked: "2026-10-06",
  },
  {
    name: "Gränbystaden", address: "Marknadsgatan 1", lat: 59.8777, lon: 17.67592, operator: "parkman", kind: "lot",
    tariff: { rules: [{ days: ALL, from: 0, to: 0, price: 10, per: 30, block: true }], freeMin: 180, cap24h: 350 },
    open: [{ days: ALL, from: 7, to: 2 }],
    priceText: "First 3 h free, then 10 kr per started 30 min; max 350 kr/day. Outdoor 07–02, garage 08–22",
    source: "https://www.granbystaden.se/besoksinfo/hitta--parkera/", checked: "2026-10-06",
  },
];
