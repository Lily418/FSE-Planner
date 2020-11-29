import { getDistance, convertDistance } from "geolib";

function closeIcaos(icao, icaos, icaodata, maxDist = 20) {
  const cIcaos = [];
  for (let i of icaos) {
    const distance = Math.round(convertDistance(getDistance(icaodata[icao], icaodata[i]), 'sm'));
    if (distance < maxDist && i !== icao) {
      cIcaos.push([i, distance]);
    }
  }
  return cIcaos;
}
// cargo: {pax, kg, pay}
function maximizeTripOnly(i, cargos, maxPax, maxKg, cache) {
  if (i === 0) {
    // Total pay, list of cargos, remain
    return [0, 0, 0, [], []];
  }
  if (cache[i+'/'+maxPax+'/'+maxKg]) { return cache[i+'/'+maxPax+'/'+maxKg]; }
  const elm = cargos[i-1];
  const [pay1, pax1, kg1, cargos1, remain1] = maximizeTripOnly(i-1, cargos, maxPax, maxKg, cache);
  if (maxPax-elm.pax >= 0 && maxKg-elm.kg >= 0)  {
    let [pay2, pax2, kg2, cargos2, remain2] = maximizeTripOnly(i-1, cargos, maxPax-elm.pax, maxKg-elm.kg, cache);
    pay2 += elm.pay;
    if (pay2 > pay1) {
      cargos2.push(elm);
      return cache[i+'/'+maxPax+'/'+maxKg] = [pay2, pax2+elm.pax, kg2+elm.kg, cargos2, remain2];
    }
  }
  remain1.push(elm);
  return cache[i+'/'+maxPax+'/'+maxKg] = [pay1, pax1, kg1, cargos1, remain1];
}
function maximizeVIP(cargos) {
  if (cargos.length === 0) {
    return [0, 0, 0, [], []];
  }
  const elm = cargos[0];
  const newCargos = cargos.slice(1);
  const [pay1, pax1, kg1, cargos1, remain1] = maximizeVIP(newCargos);
  const [pay2, pax2, kg2, cargos2, remain2] = [elm.pay, elm.pax, elm.kg, [elm], newCargos];
  if (pay1 > pay2) {
    remain1.push(elm);
    return [pay1, pax1, kg1, cargos1, remain1];
  }
  return [pay2, pax2, kg2, cargos2, remain2];
}
function maximizeCargo(cargos, maxPax, maxKg) {
  const [pay1, pax1, kg1, cargos1, remain1] = maximizeTripOnly(cargos.TripOnly.length, cargos.TripOnly, maxPax, maxKg, {});
  const [pay2, pax2, kg2, cargos2, remain2] = maximizeVIP(cargos.VIP);
  const remain = {TripOnly: remain1, VIP: remain2};
  if (pay1 >= pay2) {
    if (cargos2.length > 0) { remain.VIP = remain.VIP.concat(cargos2); }
    return [pay1, pax1, kg1, {TripOnly: cargos1, VIP: []}, remain];
  }
  if (cargos1.length > 0) { remain.TripOnly = remain.TripOnly.concat(cargos1); }
  return [pay2, pax2, kg2, {TripOnly: [], VIP: cargos2}, remain];
}

function bestLegStop(jobs, maxPax, maxKg, exclude) {
  let bestRoute = {payNM: 0, icao: null};
  for (const [i, totalDistance, j] of jobs) {
    if (exclude.includes(i)) { continue; }

    // Compute best load
    const bestLoad = maximizeTripOnly(j.cargos.TripOnly.length, j.cargos.TripOnly, maxPax, maxKg, {});
    const pay = bestLoad[0];
    if (pay <= 0) { continue; }

    // Save if better than previous loads
    if (pay/totalDistance > bestRoute.payNM) {
      bestRoute = {payNM: pay/totalDistance, icao: i, load: bestLoad, distance: j.distance};
    }
  }
  return bestRoute;
}
function getLegStops(to, jobs, maxPax, maxKg, maxStops, icaodata) {
  const maxDist = jobs.get(to).distance;

  // Keep only legs going to the same direction
  const jobsFiltered = [];
  for (const [i, j] of jobs) {
    if (i === to) { continue; }
    
    // Discard farther legs
    if (j.distance > maxDist) { continue; }

    // Compute total distance, and discard legs that stray too far away from source leg
    const totalDistance = (j.distance + convertDistance(getDistance(icaodata[i], icaodata[to]), 'sm'));
    const ratio = maxDist / totalDistance;
    if (ratio < 0.7) { continue; }

    jobsFiltered.push([i, totalDistance, j]);
  }

  const routes = [{
    icaos: [],
    cargos: [],
    pay: 0,
    distance: 0
  }];
  const exclude = [];
  for (var i = 0; i < maxStops; i++) {
    const bestRoute = bestLegStop(jobsFiltered, maxPax, maxKg, exclude);

    // Stop if no leg found
    if (!bestRoute.icao) { break; }

    const [pay, pax, kg, loadCargo] = bestRoute.load;

    // Find correct position for new airport
    let pos = 0;
    for (var k = 0; k < i; k++) {
      if (bestRoute.distance >= jobs.get(routes[i].icaos[k]).distance) {
        pos = k;
        break;
      }
    }

    const icaos = [...routes[i].icaos];
    const cargos = [...routes[i].cargos];
    icaos.splice(pos, 0, bestRoute.icao);
    cargos.splice(pos, 0, {TripOnly: loadCargo, VIP: []})

    // Compute legs distance
    let distance = jobs.get(icaos[0]).distance;
    for (k = 1; k < icaos.length; k++) {
      distance += Math.round(convertDistance(getDistance(icaodata[icaos[k-1]], icaodata[icaos[k]]), 'sm'));
    }

    routes.push({
      icaos: icaos,
      cargos: cargos,
      pay: routes[i].pay + pay,
      distance: distance
    });

    exclude.push(bestRoute.icao);
    maxPax -= pax;
    maxKg -= kg;
  }

  return routes;
}

// options: {maxPax, maxKg, icaos, icaodata}
function route(icao, jobs, options, hop, legHistory, includeLocalArea, badLegsCount, closeIcaosCache, progressStep = null) {
  // Stop when reached max iterations
  if (hop === 0) {
    return [];
  }
  hop -= 1;

  // Do not loop over same airport twice, except for the same outbound leg
  let restrictNextHop = null;
  const indexInHistory = legHistory.indexOf(icao);
  if (indexInHistory >= 0) {
    restrictNextHop = legHistory[indexInHistory+1];
  }

  // Hold found routes
  const routes = [];

  // Ensure there are jobs departing from this airport
  if (jobs[icao]) {

    // Loop over possible destinations
    for (const [to, j] of jobs[icao]) {
      if (progressStep) { postMessage({status: 'progress', progress: progressStep}); }

      // If looping, only consider the same destination as before
      if (restrictNextHop && restrictNextHop !== to) { continue; }

      // Compute best load
      const [pay, pax, kg, loadCargo, remainCargo] = maximizeCargo(j.cargos, options.maxPax, options.maxKg);
      if (pay <= 0) { continue; }

      // Ensure leg is interesting enough considering the number of previous bad legs
      let newBadLegsCount = badLegsCount;
      if (pax < options.minPaxLoad && kg < options.minKgLoad) {
        if (!badLegsCount) { continue; }
        newBadLegsCount -= 1;
      }

      let legStops = [];
      if (pax < options.maxPax && kg < options.maxKg && loadCargo.VIP.length === 0 && indexInHistory < 0) {
        legStops = getLegStops(to, jobs[icao], options.maxPax-pax, options.maxKg-kg, options.maxStops, options.icaodata);
        for (const legStop of legStops) {
          for (const c of legStop.cargos) {
            c.TripOnly = c.TripOnly.concat(loadCargo.TripOnly);
          }
        }
      }
      else {
        legStops.push({icaos:[], cargos:[], pay: 0, distance: 0});
      }
      
      // Save cargos for later use
      const savedCargos =  j.cargos;
      jobs[icao].get(to).cargos = remainCargo;

      // Compute routes
      const newRoutes = route(to, jobs, options, hop, [...legHistory, icao], true, newBadLegsCount, closeIcaosCache);
      newRoutes.push({icaos:[to], cargos:[], pay: 0, distance: 0});

      // Restore cargos
      jobs[icao].get(to).cargos = savedCargos;

      // Append routes to result
      for (const newRoute of newRoutes) {
        for (const legStop of legStops) {
          let remainDist = j.distance;
          if (legStop.icaos.length) {
            remainDist = Math.round(convertDistance(getDistance(options.icaodata[legStop.icaos[legStop.icaos.length-1]], options.icaodata[to]), 'sm'));
          }
          routes.push({
            icaos: [icao, ...legStop.icaos, ...newRoute.icaos],
            cargos: [...legStop.cargos, loadCargo, ...newRoute.cargos],
            pay: pay + legStop.pay + newRoute.pay,
            distance: legStop.distance + remainDist + newRoute.distance
          });
        }
      }
    }

  }

  // If include local area, and last leg had enough load
  if (includeLocalArea && badLegsCount) {

    // Get close-by airports
    if (!closeIcaosCache[icao]) {
      closeIcaosCache[icao] = closeIcaos(icao, options.icaos, options.icaodata);
    }

    for (const [i, distance] of closeIcaosCache[icao]) {
      if (progressStep) { postMessage({status: 'progress', progress: progressStep}); }

      // If looping, only consider the same destination as before
      if (restrictNextHop && restrictNextHop !== i) { continue; }

      // If there are jobs between the two airports, abort because it was already done
      if (jobs[icao] && jobs[icao].get(i)) { continue; }

      // Compute routes
      const newRoutes = route(i, jobs, options, hop+1, [...legHistory, icao], false, badLegsCount-1, closeIcaosCache);

      // Append routes to result
      for (const newRoute of newRoutes) {
        routes.push({
          icaos: [icao, ...newRoute.icaos],
          cargos: [{TripOnly: [], VIP: []}, ...newRoute.cargos],
          pay: newRoute.pay,
          distance: distance+newRoute.distance
        });
      }
    }
  }

  return routes;
}


onmessage = function({data}) {
  const progressStep = 100 / (closeIcaos(data.fromIcao, data.options.icaos, data.options.icaodata).length + (data.jobs[data.fromIcao] ? data.jobs[data.fromIcao].size : 0) + 1);

  const allResults = route(data.fromIcao, data.jobs, data.options, data.maxHops, [], true, data.maxBadLegs, data.closeIcaosCache, progressStep);
  postMessage({
    status: 'finished',
    results: allResults
  });
}