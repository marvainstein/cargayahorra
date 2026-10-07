-- Carga y Ahorra — esquema SQLite normalizado.
-- Montos en centavos (INTEGER). Fechas locales 'YYYY-MM-DD'. Instantes ISO-8601 UTC.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- ───────────── Catálogo ─────────────
CREATE TABLE IF NOT EXISTS payment_provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BANK','WALLET','LOYALTY','FUEL_BRAND','OTHER'))
);

CREATE TABLE IF NOT EXISTS payment_method (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES payment_provider(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('DEBIT_CARD','CREDIT_CARD','PREPAID_CARD','WALLET','CASH','OTHER')),
  network TEXT
);

CREATE TABLE IF NOT EXISTS loyalty_programme (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fuel_brand_id TEXT
);

-- Segmentos de cliente: plan de un banco, paquete, cobro de sueldo, nivel de un programa…
CREATE TABLE IF NOT EXISTS customer_segment (
  id TEXT PRIMARY KEY,
  provider_id TEXT REFERENCES payment_provider(id),
  name TEXT NOT NULL,
  question TEXT,
  -- segmentos excluyentes entre sí (p. ej. el plan de un banco): se eligen con una sola opción
  group_id TEXT
);

-- Grupo de segmentos excluyentes (p. ej. "Plan" de Brubank: One / Plus / Ultra).
CREATE TABLE IF NOT EXISTS customer_segment_group (
  id TEXT PRIMARY KEY,
  provider_id TEXT,
  label TEXT NOT NULL,
  -- se puede no tener ninguno (p. ej. no tener paquete Black+)
  allow_none INTEGER NOT NULL DEFAULT 0,
  none_label TEXT
);

CREATE TABLE IF NOT EXISTS app (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS station (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  region TEXT,
  latitude REAL,
  longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  -- atributos publicados por la fuente (p. ej. {"on": true, "products": ["QUANTIUM", ...]})
  attributes_json TEXT NOT NULL DEFAULT '{}',
  source TEXT
);

-- ───────────── Usuario ─────────────
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  currency TEXT NOT NULL DEFAULT 'ARS',
  locale TEXT NOT NULL DEFAULT 'es-AR',
  region TEXT,
  allow_split_payment TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (allow_split_payment IN ('YES','NO','UNKNOWN')),
  max_load_amount INTEGER,
  estimated_monthly_fuel_budget INTEGER,
  default_fuel_type TEXT NOT NULL DEFAULT 'SUPER',
  default_station_id TEXT REFERENCES station(id),
  default_price_per_litre INTEGER
);

CREATE TABLE IF NOT EXISTS user_payment_method (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  payment_method_id TEXT NOT NULL REFERENCES payment_method(id),
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, payment_method_id)
);

CREATE TABLE IF NOT EXISTS user_segment (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES customer_segment(id),
  status TEXT NOT NULL CHECK (status IN ('YES','NO','UNKNOWN')),
  PRIMARY KEY (user_id, segment_id)
);

CREATE TABLE IF NOT EXISTS user_loyalty_membership (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  programme_id TEXT NOT NULL REFERENCES loyalty_programme(id),
  PRIMARY KEY (user_id, programme_id)
);

CREATE TABLE IF NOT EXISTS user_app (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES app(id),
  PRIMARY KEY (user_id, app_id)
);

-- ───────────── Promociones (versionadas) ─────────────
CREATE TABLE IF NOT EXISTS promotion (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES payment_provider(id),
  fuel_brand_id TEXT,
  source_id TEXT REFERENCES source(id),
  -- clave estable dentro de la fuente para reconocer la misma promoción entre importaciones
  source_key TEXT,
  current_version_id TEXT,
  pending_review INTEGER NOT NULL DEFAULT 0,
  pending_review_reason TEXT,
  -- huella de lo último que publicó la fuente (para detectar cambios en la fuente,
  -- independiente de las ediciones manuales)
  source_fingerprint TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, source_key)
);

CREATE TABLE IF NOT EXISTS promotion_version (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL REFERENCES promotion(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','AUTOMATICALLY_IMPORTED','MANUALLY_REVIEWED','STALE','INVALID')),
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  source_url TEXT,
  source_name TEXT,
  retrieved_at TEXT,
  last_verified_at TEXT,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('PERCENTAGE','FIXED_AMOUNT','PER_LITRE')),
  discount_value INTEGER NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('INSTANT_DISCOUNT','CASHBACK')),
  stage TEXT NOT NULL CHECK (stage IN ('PRICE','PAYMENT')),
  minimum_purchase INTEGER,
  maximum_purchase INTEGER,
  minimum_litres REAL,
  required_loyalty_programme_id TEXT,
  requires_app TEXT,
  requires_qr INTEGER NOT NULL DEFAULT 0,
  requires_nfc INTEGER NOT NULL DEFAULT 0,
  requires_specific_card INTEGER NOT NULL DEFAULT 0,
  stackable TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (stackable IN ('YES','NO','UNKNOWN')),
  multiple_operations_per_day TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (multiple_operations_per_day IN ('YES','NO','UNKNOWN')),
  week_starts_on INTEGER NOT NULL DEFAULT 1,
  notes_json TEXT NOT NULL DEFAULT '[]',
  extra_json TEXT NOT NULL DEFAULT '{}',
  raw_excerpt TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  change_reason TEXT,
  UNIQUE (promotion_id, version)
);

CREATE TABLE IF NOT EXISTS promotion_cap (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL REFERENCES promotion_version(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('PER_TRANSACTION','DAILY','WEEKLY','MONTHLY','ANNUAL','LIFETIME','PROMOTION_PERIOD')),
  pool_id TEXT
);

CREATE TABLE IF NOT EXISTS promotion_usage_limit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id TEXT NOT NULL REFERENCES promotion_version(id) ON DELETE CASCADE,
  max_transactions INTEGER NOT NULL,
  period TEXT NOT NULL
);

-- Listas de elegibilidad (dimensión extensible sin migraciones):
-- PROVIDER, PAYMENT_METHOD, PAYMENT_METHOD_TYPE, NETWORK, FUEL_TYPE, STATION,
-- REGION, EXCLUDED_REGION, SEGMENT, DAY_OF_WEEK, DAY_OF_MONTH
CREATE TABLE IF NOT EXISTS promotion_eligibility (
  version_id TEXT NOT NULL REFERENCES promotion_version(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (version_id, dimension, value)
);

CREATE TABLE IF NOT EXISTS promotion_unknown_condition (
  version_id TEXT NOT NULL REFERENCES promotion_version(id) ON DELETE CASCADE,
  condition TEXT NOT NULL,
  PRIMARY KEY (version_id, condition)
);

CREATE TABLE IF NOT EXISTS promotion_stackable_with (
  version_id TEXT NOT NULL REFERENCES promotion_version(id) ON DELETE CASCADE,
  other_promotion_id TEXT NOT NULL,
  PRIMARY KEY (version_id, other_promotion_id)
);

-- Auditoría: cambios de estado, verificaciones, revisiones, desactivaciones.
CREATE TABLE IF NOT EXISTS promotion_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id TEXT NOT NULL REFERENCES promotion(id) ON DELETE CASCADE,
  version_id TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT
);

-- ───────────── Fuentes e importaciones ─────────────
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  structure_fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS import_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES source(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCESS','NO_CHANGES','PARTIAL','FAILED')),
  documents INTEGER NOT NULL DEFAULT 0,
  parsed INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]'
);

-- Cambios detectados que requieren revisión antes de afectar promociones existentes.
CREATE TABLE IF NOT EXISTS import_candidate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_run_id INTEGER NOT NULL REFERENCES import_run(id),
  source_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  promotion_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('NEW','CHANGED','MISSING')),
  payload_json TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','APPLIED','REJECTED')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS job_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT
);

-- ───────────── Precios ─────────────
CREATE TABLE IF NOT EXISTS fuel_price (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT REFERENCES station(id),
  brand_id TEXT,
  region TEXT,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('SUPER','PREMIUM','DIESEL','DIESEL_PREMIUM')),
  price INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  source TEXT NOT NULL,
  last_updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fuel_price_lookup ON fuel_price (fuel_type, brand_id, station_id, effective_from);

-- ───────────── Historial ─────────────
CREATE TABLE IF NOT EXISTS fuel_transaction (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  station_id TEXT REFERENCES station(id),
  fuel_type TEXT NOT NULL,
  litres REAL,
  price_per_litre INTEGER,
  gross_amount INTEGER NOT NULL,
  payment_method_id TEXT NOT NULL REFERENCES payment_method(id),
  discount_amount INTEGER NOT NULL DEFAULT 0,
  cashback_amount INTEGER NOT NULL DEFAULT 0,
  recommended_benefit INTEGER,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON fuel_transaction (user_id, local_date);

CREATE TABLE IF NOT EXISTS fuel_transaction_promotion (
  transaction_id TEXT NOT NULL REFERENCES fuel_transaction(id) ON DELETE CASCADE,
  promotion_id TEXT NOT NULL REFERENCES promotion(id),
  promotion_version_id TEXT NOT NULL REFERENCES promotion_version(id),
  discount_amount INTEGER NOT NULL DEFAULT 0,
  cashback_amount INTEGER NOT NULL DEFAULT 0,
  pool_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (transaction_id, promotion_id)
);

-- Consumo de topes fuera de la app (p. ej. tope compartido con supermercado).
CREATE TABLE IF NOT EXISTS cap_usage_adjustment (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  promotion_id TEXT REFERENCES promotion(id),
  pool_id TEXT,
  amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- Bloques de texto oficial vigilados (fuentes que no se interpretan solas, p. ej. Axion).
-- Una promoción se vincula a un bloque con source_key = '<block_key>#<variante>'.
CREATE TABLE IF NOT EXISTS source_watch (
  source_id TEXT NOT NULL,
  block_key TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  missing_since TEXT,
  PRIMARY KEY (source_id, block_key)
);
