CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, deleting boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS imports (id uuid PRIMARY KEY, owner text NOT NULL REFERENCES users ON DELETE CASCADE, expected integer NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS media (id uuid PRIMARY KEY, owner text NOT NULL REFERENCES users ON DELETE CASCADE, import_id uuid NOT NULL REFERENCES imports ON DELETE CASCADE, filename text NOT NULL, kind text NOT NULL, bytes bigint NOT NULL, hash text, phash text, pixels text, screenshot boolean DEFAULT false, thumb text, work text, category text NOT NULL, caption text DEFAULT '', tags text DEFAULT '', state text NOT NULL, taken_at timestamptz, geo jsonb, source text, review boolean DEFAULT false);
CREATE INDEX IF NOT EXISTS media_owner_time ON media(owner,taken_at);
CREATE TABLE IF NOT EXISTS jobs (id uuid PRIMARY KEY, owner text NOT NULL REFERENCES users ON DELETE CASCADE, members uuid[] NOT NULL, state text DEFAULT 'queued', attempts integer DEFAULT 0, lease timestamptz, reserved numeric NOT NULL, actual numeric, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_log(owner text REFERENCES users ON DELETE CASCADE, action text, at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS budgets(owner text REFERENCES users ON DELETE CASCADE, month timestamptz, amount numeric NOT NULL, PRIMARY KEY(owner,month));
ALTER TABLE imports ADD COLUMN IF NOT EXISTS model_enabled boolean DEFAULT false;
ALTER TABLE media ADD COLUMN IF NOT EXISTS position integer;
CREATE UNIQUE INDEX IF NOT EXISTS media_position ON media(import_id,position);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES imports ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS batch_no integer;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_batch ON jobs(import_id,batch_no);
CREATE TABLE IF NOT EXISTS photo_connections (
 owner text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
 access_enc text NOT NULL, refresh_enc text, expires timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS photo_sessions (
 owner text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
 id uuid NOT NULL UNIQUE, remote_id text, picker_uri text, state text NOT NULL,
 expires timestamptz, poll_until timestamptz, next_poll timestamptz,
 selected jsonb NOT NULL DEFAULT '[]', deadline timestamptz,
 lease uuid, lease_until timestamptz, completed integer DEFAULT 0, errors integer DEFAULT 0
);
ALTER TABLE imports ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE media ADD COLUMN IF NOT EXISTS google_id text;
CREATE UNIQUE INDEX IF NOT EXISTS media_google_id ON media(owner,google_id) WHERE google_id IS NOT NULL;
ALTER TABLE media ALTER COLUMN bytes DROP NOT NULL;
-- Slice 0: per-item analysis, kept out of media so media stays lean.
CREATE TABLE IF NOT EXISTS analysis (
 media_id uuid PRIMARY KEY REFERENCES media ON DELETE CASCADE,
 sharpness real,
 exposure jsonb,
 ocr_text text,
 doc jsonb,
 embedding vector(1536),
 burst_key text,
 event_id uuid
);
CREATE INDEX IF NOT EXISTS analysis_burst ON analysis(burst_key) WHERE burst_key IS NOT NULL;

-- Slice 0: duplicate groups become durable rows instead of a per-request recomputation.
CREATE TABLE IF NOT EXISTS dupe_groups (
 id uuid PRIMARY KEY,
 owner text NOT NULL REFERENCES users ON DELETE CASCADE,
 kind text NOT NULL,
 keeper_id uuid NOT NULL REFERENCES media ON DELETE CASCADE,
 member_ids uuid[] NOT NULL,
 bytes_reclaimable bigint NOT NULL DEFAULT 0,
 unknown_sizes integer NOT NULL DEFAULT 0,
 built_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dupe_groups_owner ON dupe_groups(owner);

-- Slice 0: categories become per-user data, seeded from the previous hardcoded list.
CREATE TABLE IF NOT EXISTS categories (
 owner text NOT NULL REFERENCES users ON DELETE CASCADE,
 key text NOT NULL,
 kind text NOT NULL,
 label text NOT NULL,
 emoji text NOT NULL DEFAULT '',
 rule text NOT NULL DEFAULT '',
 sort_order integer NOT NULL DEFAULT 0,
 PRIMARY KEY (owner, key)
);

-- Slice 0: a non-null sort key so keyset pagination can use a plain b-tree index.
-- A literal cast is not immutable, so this cannot be an expression index or a generated column.
ALTER TABLE media ADD COLUMN IF NOT EXISTS sort_at timestamptz NOT NULL DEFAULT '-infinity';
UPDATE media SET sort_at = coalesce(taken_at, '-infinity') WHERE sort_at = '-infinity' AND taken_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_owner_keyset ON media(owner, sort_at DESC, id DESC);
