import test from 'node:test';
import assert from 'node:assert/strict';
import config from './config/sites.json' with { type: 'json' };
import { classifySite, haversineMeters } from './src/geo.js';

test('exact site coordinate is classified', () => {
  const s = config.sites[0];
  const result = classifySite(s.latitude, s.longitude, config.sites, 300);
  assert.equal(result.classified, true);
  assert.equal(result.site.id, s.id);
  assert.ok(result.distanceMeters < 1);
});

test('far coordinate is unclassified', () => {
  const result = classifySite(37.5665, 126.9780, config.sites, 300);
  assert.equal(result.classified, false);
});

test('all sites are separated by more than 600m', () => {
  for (let i=0;i<config.sites.length;i++) for (let j=i+1;j<config.sites.length;j++) {
    assert.ok(haversineMeters(config.sites[i].latitude, config.sites[i].longitude, config.sites[j].latitude, config.sites[j].longitude) > 600);
  }
});
