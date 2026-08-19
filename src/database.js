const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL が設定されていません。",
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// --------------------------------------------------
// DB初期化
// --------------------------------------------------

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,

      speaker INTEGER NOT NULL DEFAULT 3,

      speed_scale DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      pitch_scale DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      intonation_scale DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      volume_scale DOUBLE PRECISION NOT NULL DEFAULT 1.0,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (guild_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_dictionary (
      guild_id TEXT NOT NULL,
      source TEXT NOT NULL,
      reading TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, source)
    );
  `);

  console.log("PostgreSQLの初期化が完了しました。");
}

// --------------------------------------------------
// ユーザー設定取得
// --------------------------------------------------

async function getUserSettings(guildId, userId) {
  const result = await pool.query(
    `
      INSERT INTO user_settings (
        guild_id,
        user_id
      )
      VALUES ($1, $2)
      ON CONFLICT (guild_id, user_id)
      DO NOTHING
      RETURNING *;
    `,
    [guildId, userId],
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  const existing = await pool.query(
    `
      SELECT *
      FROM user_settings
      WHERE guild_id = $1
        AND user_id = $2
    `,
    [guildId, userId],
  );

  return existing.rows[0];
}

// --------------------------------------------------
// 話者変更
// --------------------------------------------------

async function setSpeaker(
  guildId,
  userId,
  speaker,
) {
  await pool.query(
    `
      INSERT INTO user_settings (
        guild_id,
        user_id,
        speaker
      )
      VALUES ($1, $2, $3)

      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET
        speaker = EXCLUDED.speaker,
        updated_at = NOW()
    `,
    [
      guildId,
      userId,
      speaker,
    ],
  );
}

// --------------------------------------------------
// 音声設定をまとめて変更
// --------------------------------------------------

async function setVoiceSettings(
  guildId,
  userId,
  settings,
) {
  await pool.query(
    `
      INSERT INTO user_settings (
        guild_id,
        user_id,
        speaker,
        speed_scale,
        pitch_scale,
        intonation_scale,
        volume_scale
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)

      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET
        speaker = EXCLUDED.speaker,
        speed_scale = EXCLUDED.speed_scale,
        pitch_scale = EXCLUDED.pitch_scale,
        intonation_scale = EXCLUDED.intonation_scale,
        volume_scale = EXCLUDED.volume_scale,
        updated_at = NOW()
    `,
    [
      guildId,
      userId,
      settings.speaker,
      settings.speed_scale,
      settings.pitch_scale,
      settings.intonation_scale,
      settings.volume_scale,
    ],
  );
}

// --------------------------------------------------
// 辞典
// --------------------------------------------------

async function getGuildDictionary(guildId) {
  const result = await pool.query(
    `
      SELECT source, reading
      FROM guild_dictionary
      WHERE guild_id = $1
      ORDER BY char_length(source) DESC, source ASC
    `,
    [guildId],
  );

  return result.rows;
}

async function upsertDictionaryEntry(
  guildId,
  source,
  reading,
) {
  await pool.query(
    `
      INSERT INTO guild_dictionary (guild_id, source, reading)
      VALUES ($1, $2, $3)
      ON CONFLICT (guild_id, source)
      DO UPDATE SET
        reading = EXCLUDED.reading,
        updated_at = NOW()
    `,
    [guildId, source, reading],
  );
}

async function deleteDictionaryEntry(guildId, source) {
  const result = await pool.query(
    `
      DELETE FROM guild_dictionary
      WHERE guild_id = $1 AND source = $2
      RETURNING source, reading
    `,
    [guildId, source],
  );

  return result.rows[0] ?? null;
}

// --------------------------------------------------
// DB終了
// --------------------------------------------------

async function closeDatabase() {
  await pool.end();
}

module.exports = {
  pool,
  initDatabase,
  getUserSettings,
  setSpeaker,
  setVoiceSettings,
  getGuildDictionary,
  upsertDictionaryEntry,
  deleteDictionaryEntry,
  closeDatabase,
};