ALTER TABLE jobs ADD COLUMN head_configs_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(head_configs_json) AND json_type(head_configs_json) = 'array');
