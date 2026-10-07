import type { Station } from '../../core/types';
import { type DB, run, transaction } from './db';

/** Alta/actualización de estaciones (p. ej. las del anexo de unas bases). */
export function upsertStations(db: DB, stations: Station[]) {
  if (stations.length === 0) return;
  transaction(db, () => {
    for (const s of stations)
      run(
        db,
        `INSERT INTO station (id, brand_id, name, address, region, latitude, longitude, active) VALUES (?,?,?,?,?,?,?,1)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address, region = COALESCE(excluded.region, station.region), active = 1`,
        s.id,
        s.brandId,
        s.name,
        s.address,
        s.region,
        s.latitude,
        s.longitude,
      );
  });
}
