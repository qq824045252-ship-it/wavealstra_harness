CREATE TABLE IF NOT EXISTS gateway_execution_sources (
  task_id VARCHAR PRIMARY KEY,
  channel_id VARCHAR NOT NULL,
  connection_key VARCHAR NOT NULL,
  chat_id VARCHAR NOT NULL,
  sender_id VARCHAR NOT NULL,
  platform VARCHAR NOT NULL,
  audience VARCHAR NOT NULL CHECK(audience IN ('private','shared')),
  personal_memory_binding_id VARCHAR
);
