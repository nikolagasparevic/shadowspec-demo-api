CREATE SCHEMA IF NOT EXISTS shadowspec_internal;

CREATE TABLE shadowspec_internal.replay_target (
  singleton_id SMALLINT PRIMARY KEY
    CHECK (singleton_id = 1),

  marker_version INTEGER NOT NULL
    CHECK (marker_version = 1),

  project_id UUID NOT NULL,

  replay_database_id UUID NOT NULL,

  database_name TEXT NOT NULL,

  token_sha256 CHAR(64) NOT NULL
    CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),

  authorized_at TIMESTAMPTZ NOT NULL
    DEFAULT CURRENT_TIMESTAMP
);
