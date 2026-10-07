import type { Station } from '../../core/types';
import { type DB, run, transaction } from './db';

/** Alta/actualización de estaciones (p. ej. las del anexo de unas bases). */
export function upsertStations(db: DB, stations: Station[], source?: string) {
  if (stations.length === 0) return;
  transaction(db, () => {
    for (const s of stations)
      run(
        db,
        `INSERT INTO station (id, brand_id, name, address, region, latitude, longitude, active, attributes_json, source) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address, region = COALESCE(excluded.region, station.region),
           latitude = COALESCE(excluded.latitude, station.latitude), longitude = COALESCE(excluded.longitude, station.longitude),
           active = excluded.active, attributes_json = excluded.attributes_json, source = COALESCE(excluded.source, station.source)`,
        s.id,
        s.brandId,
        s.name,
        s.address,
        s.region,
        s.latitude,
        s.longitude,
        s.active ? 1 : 0,
        JSON.stringify(s.attributes ?? {}),
        source ?? null,
      );
  });
}
