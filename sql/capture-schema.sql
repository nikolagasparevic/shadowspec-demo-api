CREATE TABLE IF NOT EXISTS api_requests (
    id SERIAL PRIMARY KEY,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(255) NOT NULL,
    path_params JSONB,
    query_params JSONB,
    request_body JSONB,
    response_status INTEGER NOT NULL,
    response_body JSONB,
    session_id VARCHAR(100),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_request_snapshots (
    id SERIAL PRIMARY KEY,
    api_request_id INTEGER NOT NULL
        REFERENCES api_requests(id)
        ON DELETE CASCADE,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS
    api_requests_active_session_id_id_idx
    ON api_requests (active, session_id, id);

CREATE INDEX IF NOT EXISTS
    api_request_snapshots_api_request_id_idx
    ON api_request_snapshots (api_request_id);
