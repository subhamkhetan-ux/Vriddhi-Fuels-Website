// The share pictures (share-svg.js), drawn from the made-up demo data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../../fleet/js/demo.js';
import { byRoute, byVehicle, dieselRecon, inPeriod, monthly, ssfcAccount, vehiclesOf } from '../../fleet/js/analyse.js';
import { driverCheck, withDefaults } from '../../fleet/js/rules.js';
import { bulkerSvg } from '../../fleet/js/bulker.js';
import {
  driverPagesSvg, fleetPagesSvg, PAGE, placeBulker, reconPagesSvg, roadCardSvg, ssfcPagesSvg, tripCardSvg, vehiclePagesSvg,
} from '../../fleet/js/share-svg.js';

const TODAY = '2026-10-11';
const d = demoData(TODAY);
const clean = (svg) => {
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /undefined|NaN|\[object Object\]/);
  assert.equal((svg.match(/<svg/g) || []).length, (svg.match(/<\/svg>/g) || []).length);
};

test('the SSFC account: every pending invoice and every payment, over A4-shaped pages', () => {
  const a = ssfcAccount(d.ssfc, TODAY);
  const pages = ssfcPagesSvg(a, { asOn: TODAY });
  pages.forEach(clean);
  assert.ok(pages[0].includes(`width="${PAGE.width}" height="${PAGE.height}"`));
  const all = pages.join('');
  assert.ok(all.includes('SSFC OWES US (WITH GST)'));
  assert.ok(all.includes('DEMO FREIGHT CARRIER'));
  const paid = a.payments.length;
  assert.equal((all.match(/In SSL account|Own diesel|In cash|Market HSD/g) || []).length, paid);
  if (pages.length > 1) assert.ok(pages[1].includes(`Page 2 of ${pages.length}`));
  assert.ok(ssfcPagesSvg(a, { gst: false }).join('').includes('WITHOUT GST'));
});

test('a vehicle statement lists every trip in the period with its money, a table head on each page', () => {
  const veh = vehiclesOf(d)[0];
  const trips = d.trips.filter((t) => t.veh === veh);
  const recon = dieselRecon(d).vehicles.find((v) => v.veh === veh);
  const pages = vehiclePagesSvg(veh, trips, { period: 'All trips', asOn: TODAY, recon, driver: 'Ramesh' });
  pages.forEach(clean);
  const all = pages.join('');
  for (const t of trips) assert.ok(all.includes(t.trip), t.trip);
  assert.ok(all.includes('XX 01 AB 1001'));
  assert.ok(pages.length > 1, 'all of a vehicle\'s demo trips take more than a page');
  pages.slice(1).forEach((p) => { if (trips.some((t) => p.includes(`>${t.trip} · `))) assert.ok(p.includes('TRIP · ROUTE'), 'a continued table repeats its head'); });
  reconPagesSvg(recon, { asOn: TODAY }).forEach(clean);
});

test('a trip card carries the bulker, the money and the diesel', () => {
  const t = d.trips.find((x) => x.status === 'done' && x.bhada);
  const { svg, size } = tripCardSvg(t, { asOn: TODAY, bulker: bulkerSvg({ state: 'loaded', load: t.loadWt, gross: t.gross, plate: t.veh }), fills: d.hsd.filter((h) => h.veh === t.veh && h.trip === t.trip) });
  clean(svg);
  assert.equal(size.width, 1080);
  assert.ok(svg.includes('Income from the trip'));
  assert.ok(svg.includes('class="bulker'));                      // the drawing, as a group keeping its classes
  assert.match(placeBulker('<svg class="bulker is-loaded" viewBox="0 -3 424 139"><rect/></svg>', 10, 20, 300, 98), /^<svg x="10" y="20" width="300" height="98" viewBox="0 -3 424 139"[^>]*><g class="bulker is-loaded"><rect\/><\/g><\/svg>$/);
});

test('a driver statement, the fleet report and on the road now', () => {
  const dc = driverCheck(d, withDefaults({ routes: [{ port: 'Kakinada', dest: 'BALCO', salary: 11000 }], driver: { checkFrom: '2025-01' } }), TODAY);
  const sp = dc.spells.find((x) => x.payments.length);
  driverPagesSvg(sp, dc.rows.filter((r) => r.spell === sp), { asOn: TODAY }).forEach(clean);
  const trips = d.trips.filter((t) => inPeriod(t, { from: '2026-04', to: '2026-10' }));
  const ms = trips.map((t) => t.month).sort();
  const fleet = fleetPagesSvg(trips, { period: 'This FY', asOn: TODAY, vehicles: byVehicle(trips, vehiclesOf(d)), routes: byRoute(trips), months: monthly(trips, ms[0], ms[ms.length - 1]) });
  fleet.forEach(clean);
  assert.ok(fleet.join('').includes('BY VEHICLE'));
  const road = roadCardSvg([{ veh: 'XX01AB1001', state: 'loaded', title: 'Kakinada → BALCO', phase: 'Loaded', sub: 'T001', pace: 'On the best pace', paceColor: 'good', bulker: bulkerSvg({ state: 'loaded', load: 40, plate: 'XX01AB1001' }) }], { asOn: TODAY });
  clean(road.svg);
  assert.ok(road.svg.includes('1 of 1 bulker on a trip'));
});
