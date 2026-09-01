export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function classifySite(latitude, longitude, sites, radiusMeters) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { classified: false, reason: 'NO_GPS', site: null, distanceMeters: null };
  }

  let nearest = null;
  for (const site of sites) {
    const distanceMeters = haversineMeters(latitude, longitude, site.latitude, site.longitude);
    if (!nearest || distanceMeters < nearest.distanceMeters) nearest = { site, distanceMeters };
  }

  if (!nearest || nearest.distanceMeters > radiusMeters) {
    return {
      classified: false,
      reason: 'OUTSIDE_RADIUS',
      site: nearest?.site ?? null,
      distanceMeters: nearest?.distanceMeters ?? null
    };
  }

  return { classified: true, reason: 'WITHIN_RADIUS', ...nearest };
}
