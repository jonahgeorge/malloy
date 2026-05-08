#!/bin/bash
set -e

SCRIPTDIR=$(cd $(dirname $0); pwd)
DATADIR=$(dirname $SCRIPTDIR)/data/malloytest-parquet
DUCKDBDIR=$(dirname $SCRIPTDIR)/data/duckdb
CONTAINER_NAME="mssql-malloy"
SA_PASSWORD="Malloy_Test_123"
DB_NAME="malloytest"
HOST_PORT="${MSSQL_HOST_PORT:-11433}"

# Require duckdb CLI (used for readiness check and data loading)
if ! command -v duckdb > /dev/null 2>&1; then
  echo "Error: duckdb CLI is required but not found"
  exit 1
fi

# Check for existing container
if docker container inspect "$CONTAINER_NAME" > /dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" = "true" ]; then
    echo "$CONTAINER_NAME is already running"
    exit 0
  fi
  echo "Restarting existing $CONTAINER_NAME container..."
  docker start "$CONTAINER_NAME"
  echo -n "Waiting for MSSQL..."
  for i in $(seq 1 60); do
    duckdb -c "LOAD mssql; ATTACH 'Server=localhost,$HOST_PORT;Database=master;User Id=sa;Password=$SA_PASSWORD;TrustServerCertificate=true' AS _ping (TYPE mssql);" > /dev/null 2>&1 && break
    echo -n "."
    sleep 2
  done
  echo " ready"
  echo "MSSQL running on port $HOST_PORT"
  exit 0
fi

# Always use SQL Server 2022 — the dialect targets T-SQL 2022 features
# (JSON_OBJECT, JSON_ARRAY, DATEDIFF_BIG). Azure SQL Edge is ARM-native but
# lacks those JSON functions, so on ARM64 Macs we emulate amd64.
IMAGE="mcr.microsoft.com/mssql/server:2022-latest"
ARCH=$(uname -m)
PLATFORM_FLAG=""
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
  PLATFORM_FLAG="--platform=linux/amd64"
fi

echo "Starting $CONTAINER_NAME ($IMAGE $PLATFORM_FLAG)..."
docker run -d \
  --name "$CONTAINER_NAME" \
  $PLATFORM_FLAG \
  -e "ACCEPT_EULA=Y" \
  -e "MSSQL_SA_PASSWORD=$SA_PASSWORD" \
  -p $HOST_PORT:1433 \
  "$IMAGE"

# Wait for server to accept connections (check via DuckDB mssql extension)
counter=0
echo -n "Waiting for MSSQL..."
while true; do
  duckdb -c "LOAD mssql; ATTACH 'Server=localhost,$HOST_PORT;Database=master;User Id=sa;Password=$SA_PASSWORD;TrustServerCertificate=true' AS _ping (TYPE mssql);" > /dev/null 2>&1 && break
  counter=$((counter + 1))
  if [ $counter -ge 60 ]; then
    echo
    echo "MSSQL did not start within 2 minutes"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -20
    docker rm -f "$CONTAINER_NAME"
    exit 1
  fi
  echo -n "."
  sleep 2
done
echo " ready"

# Load test data using DuckDB + mssql extension
echo "Loading test data..."
duckdb -c "
LOAD mssql;

-- Create database
ATTACH 'Server=localhost,$HOST_PORT;Database=master;User Id=sa;Password=$SA_PASSWORD;TrustServerCertificate=true' AS msdb (TYPE mssql);
SELECT mssql_exec('msdb', 'IF DB_ID(''$DB_NAME'') IS NOT NULL DROP DATABASE $DB_NAME');
SELECT mssql_exec('msdb', 'CREATE DATABASE $DB_NAME');
DETACH msdb;

-- Connect to test database
ATTACH 'Server=localhost,$HOST_PORT;Database=$DB_NAME;User Id=sa;Password=$SA_PASSWORD;TrustServerCertificate=true' AS msdb (TYPE mssql);

-- Create malloytest schema so table paths (malloytest.flights etc.) match DuckDB tests
SELECT mssql_exec('msdb', 'CREATE SCHEMA malloytest');

-- Create tables: schemas must match the parquet files in test/data/malloytest-parquet/.
-- If a parquet schema changes, update the corresponding CREATE TABLE below.
-- All columns explicitly nullable to match parquet semantics.
SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.aircraft (
  id BIGINT NULL, tail_num NVARCHAR(MAX) NULL, aircraft_serial NVARCHAR(MAX) NULL,
  aircraft_model_code NVARCHAR(MAX) NULL, aircraft_engine_code NVARCHAR(MAX) NULL,
  year_built INT NULL, aircraft_type_id INT NULL, aircraft_engine_type_id INT NULL,
  registrant_type_id INT NULL, name NVARCHAR(MAX) NULL, address1 NVARCHAR(MAX) NULL,
  address2 NVARCHAR(MAX) NULL, city NVARCHAR(MAX) NULL, state NVARCHAR(MAX) NULL,
  zip NVARCHAR(MAX) NULL, region NVARCHAR(MAX) NULL, county NVARCHAR(MAX) NULL,
  country NVARCHAR(MAX) NULL, certification NVARCHAR(MAX) NULL, status_code NVARCHAR(MAX) NULL,
  mode_s_code NVARCHAR(MAX) NULL, fract_owner NVARCHAR(MAX) NULL,
  last_action_date NVARCHAR(MAX) NULL, cert_issue_date NVARCHAR(MAX) NULL,
  air_worth_date NVARCHAR(MAX) NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.aircraft_models (
  aircraft_model_code NVARCHAR(MAX) NULL, manufacturer NVARCHAR(MAX) NULL,
  model NVARCHAR(MAX) NULL, aircraft_type_id INT NULL, aircraft_engine_type_id INT NULL,
  aircraft_category_id INT NULL, amateur INT NULL, engines INT NULL,
  seats INT NULL, weight INT NULL, speed INT NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.airports (
  id INT NULL, code NVARCHAR(MAX) NULL, site_number NVARCHAR(MAX) NULL,
  fac_type NVARCHAR(MAX) NULL, fac_use NVARCHAR(MAX) NULL, faa_region NVARCHAR(MAX) NULL,
  faa_dist NVARCHAR(MAX) NULL, city NVARCHAR(MAX) NULL, county NVARCHAR(MAX) NULL,
  state NVARCHAR(MAX) NULL, full_name NVARCHAR(MAX) NULL, own_type NVARCHAR(MAX) NULL,
  longitude FLOAT NULL, latitude FLOAT NULL, elevation INT NULL,
  aero_cht NVARCHAR(MAX) NULL, cbd_dist INT NULL, cbd_dir NVARCHAR(MAX) NULL,
  act_date NVARCHAR(MAX) NULL, cert NVARCHAR(MAX) NULL, fed_agree NVARCHAR(MAX) NULL,
  cust_intl NVARCHAR(MAX) NULL, c_ldg_rts NVARCHAR(MAX) NULL, joint_use NVARCHAR(MAX) NULL,
  mil_rts NVARCHAR(MAX) NULL, cntl_twr NVARCHAR(MAX) NULL, major NVARCHAR(MAX) NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.carriers (
  code NVARCHAR(MAX) NULL, name NVARCHAR(MAX) NULL, nickname NVARCHAR(MAX) NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.flights (
  carrier NVARCHAR(MAX) NULL, origin NVARCHAR(MAX) NULL, destination NVARCHAR(MAX) NULL,
  flight_num INT NULL, flight_time INT NULL, tail_num NVARCHAR(MAX) NULL,
  dep_time DATETIME NULL, arr_time DATETIME NULL, dep_delay INT NULL,
  arr_delay INT NULL, taxi_out INT NULL, taxi_in INT NULL, distance INT NULL,
  cancelled NVARCHAR(MAX) NULL, diverted NVARCHAR(MAX) NULL, id2 INT NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.state_facts (
  state NVARCHAR(MAX) NULL, aircraft_count INT NULL, airport_count INT NULL,
  births INT NULL, popular_name NVARCHAR(MAX) NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.numbers (
  num INT NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.words (
  word NVARCHAR(MAX) NULL
)');

SELECT mssql_exec('msdb', 'CREATE TABLE malloytest.alltypes (
  t_int64 BIGINT NULL, t_float64 FLOAT NULL,
  t_numeric DECIMAL(38,9) NULL, t_bignumeric DECIMAL(38,9) NULL,
  string NVARCHAR(MAX) NULL,
  t_bool_true BIT NULL, t_bool_false BIT NULL, t_bool_null BIT NULL,
  t_date DATE NULL, t_datetime DATETIME NULL, t_timestamp DATETIME NULL
)');

SELECT mssql_refresh_cache('msdb');

-- Load data from parquet files
INSERT INTO msdb.malloytest.aircraft SELECT * FROM read_parquet('$DATADIR/aircraft.parquet');
INSERT INTO msdb.malloytest.aircraft_models SELECT * FROM read_parquet('$DATADIR/aircraft_models.parquet');
INSERT INTO msdb.malloytest.airports SELECT * FROM read_parquet('$DATADIR/airports.parquet');
INSERT INTO msdb.malloytest.carriers SELECT * FROM read_parquet('$DATADIR/carriers.parquet');
INSERT INTO msdb.malloytest.flights SELECT * FROM read_parquet('$DATADIR/flights.parquet');
INSERT INTO msdb.malloytest.state_facts SELECT * FROM read_parquet('$DATADIR/state_facts.parquet');
INSERT INTO msdb.malloytest.numbers SELECT * FROM read_parquet('$DUCKDBDIR/numbers.parquet');
INSERT INTO msdb.malloytest.words SELECT * FROM read_parquet('$DUCKDBDIR/words.parquet');
INSERT INTO msdb.malloytest.alltypes SELECT t_int64, t_float64, t_numeric, t_bignumeric, string, t_bool_true, t_bool_false, t_bool_null, t_date, t_datetime, t_timestamp FROM read_parquet('$DATADIR/alltypes.parquet');

-- Verify row counts
SELECT 'aircraft' as tbl, COUNT(*) as rows FROM msdb.malloytest.aircraft
UNION ALL SELECT 'aircraft_models', COUNT(*) FROM msdb.malloytest.aircraft_models
UNION ALL SELECT 'airports', COUNT(*) FROM msdb.malloytest.airports
UNION ALL SELECT 'carriers', COUNT(*) FROM msdb.malloytest.carriers
UNION ALL SELECT 'flights', COUNT(*) FROM msdb.malloytest.flights
UNION ALL SELECT 'state_facts', COUNT(*) FROM msdb.malloytest.state_facts
UNION ALL SELECT 'numbers', COUNT(*) FROM msdb.malloytest.numbers
UNION ALL SELECT 'words', COUNT(*) FROM msdb.malloytest.words
UNION ALL SELECT 'alltypes', COUNT(*) FROM msdb.malloytest.alltypes;
"

echo
echo "MSSQL running on port $HOST_PORT, database: $DB_NAME"
echo "  Connection: Server=localhost,$HOST_PORT;Database=$DB_NAME;User Id=sa;Password=$SA_PASSWORD;TrustServerCertificate=true"
