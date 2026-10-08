# ParkUpp

Find the nearest and cheapest parking in Uppsala for a given destination, date and length of stay,
with the total price and which app to pay with.

## How it works

- **Kommun street parking and car parks** come from Uppsala kommun's parking map
  (ArcGIS FeatureServer at kartportal.uppsala.se). `data/build_data.py` downloads it and writes
  `data/kommun.js`. A GitHub Action re-runs it on the 1st of every month.
- **Private car parks** (Aimo Park, Apcoa, Region Uppsala, Smart Parkering, Gränbystaden) are entered
  by hand in `data/carparks.js`, each with a source link and a `checked` date.
- **`tariff.js`** calculates the price for a stay, following Swedish sign rules: plain times are
  weekdays, times in (parentheses) are Saturdays and days before holidays, and Sundays/holidays are free
  unless stated.
- **Destination search** looks up addresses in Uppsala kommun's address register (`data/addresses.js`,
  searched in the browser, so typos like "Krukmarkgatan" still find Krukmakargatan). Clinics and other
  healthcare units come from a monthly snapshot of 1177 Hitta vård (`data/clinics.js`, with the hospital
  entrance where 1177 lists one). Other places and businesses come from Photon (komoot), falling back to
  Nominatim. Map tiles are from OpenStreetMap.
- **Other car parks** come from OpenStreetMap (`data/osm.js`), shown with a "check the sign" warning.

Prices are estimates. Always check the sign on site.

## Run locally

```sh
python3 -m http.server 8765
# open http://127.0.0.1:8765/
```

Opening `index.html` directly as a file won't work: OpenStreetMap blocks map tiles without a web origin.

## Update data

```sh
python3 data/build_data.py            # download fresh data; rebuilds kommun.js, osm.js, addresses.js and clinics.js
python3 data/build_data.py --offline  # rebuild from already-downloaded files
```

Private car park prices: edit `data/carparks.js` and update the `checked` date.
