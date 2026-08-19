const mysql = require("mysql2/promise");
const fs = require("fs");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL が設定されていません。");
}

// --------------------------------------------------
// MySQL接続
// --------------------------------------------------

let connectionConfig;

try {
  const url = new URL(databaseUrl);

  connectionConfig = {
    host: url.hostname,
    port: url.port
      ? Number(url.port)
      : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4",
  };

  // SSLが必要な場合のみCA証明書を使用
  if (process.env.DB_SSL === "true") {
    connectionConfig.ssl = {
      ca: fs.readFileSync(
        "/app/certs/conoha-ca.crt",
        "utf8",
      ),
      rejectUnauthorized: true,
    };
  }
} catch (error) {
  throw new Error(
    `DATABASE_URLの解析に失敗しました: ${error.message}`,
  );
}

const pool = mysql.createPool(connectionConfig);

// --------------------------------------------------
// DB初期化
// --------------------------------------------------

async function initDatabase() {
  const connection = await pool.getConnection();

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        guild_id VARCHAR(255) NOT NULL,
        user_id VARCHAR(255) NOT NULL,

        speaker INT NOT NULL DEFAULT 3,

        speed_scale DOUBLE NOT NULL DEFAULT 1.0,
        pitch_scale DOUBLE NOT NULL DEFAULT 0.0,
        intonation_scale DOUBLE NOT NULL DEFAULT 1.0,
        volume_scale DOUBLE NOT NULL DEFAULT 1.0,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (guild_id, user_id)
      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS guild_dictionary (
        guild_id VARCHAR(255) NOT NULL,
        source VARCHAR(255) NOT NULL,
        reading TEXT NOT NULL,

        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (guild_id, source)
      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci;
    `);

    console.log("MySQLの初期化が完了しました。");
  } finally {
    connection.release();
  }
}

// --------------------------------------------------
// ユーザー設定取得
// --------------------------------------------------

async function getUserSettings(guildId, userId) {
  const [existing] = await pool.query(
    `
      SELECT *
      FROM user_settings
      WHERE guild_id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [guildId, userId],
  );

  if (existing.length > 0) {
    return existing[0];
  }

  await pool.query(
    `
      INSERT INTO user_settings (
        guild_id,
        user_id
      )
      VALUES (?, ?)
    `,
    [guildId, userId],
  );

  const [result] = await pool.query(
    `
      SELECT *
      FROM user_settings
      WHERE guild_id = ?
        AND user_id = ?
      LIMIT 1
    `,
    [guildId, userId],
  );

  return result[0];
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
      VALUES (?, ?, ?)

      ON DUPLICATE KEY UPDATE
        speaker = VALUES(speaker),
        updated_at = CURRENT_TIMESTAMP
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
      VALUES (?, ?, ?, ?, ?, ?, ?)

      ON DUPLICATE KEY UPDATE
        speaker = VALUES(speaker),
        speed_scale = VALUES(speed_scale),
        pitch_scale = VALUES(pitch_scale),
        intonation_scale = VALUES(intonation_scale),
        volume_scale = VALUES(volume_scale),
        updated_at = CURRENT_TIMESTAMP
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
  const [rows] = await pool.query(
    `
      SELECT source, reading
      FROM guild_dictionary
      WHERE guild_id = ?
      ORDER BY CHAR_LENGTH(source) DESC, source ASC
    `,
    [guildId],
  );

  return rows;
}

async function upsertDictionaryEntry(
  guildId,
  source,
  reading,
) {
  await pool.query(
    `
      INSERT INTO guild_dictionary (
        guild_id,
        source,
        reading
      )
      VALUES (?, ?, ?)

      ON DUPLICATE KEY UPDATE
        reading = VALUES(reading),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      guildId,
      source,
      reading,
    ],
  );
}

async function deleteDictionaryEntry(
  guildId,
  source,
) {
  const [result] = await pool.query(
    `
      DELETE FROM guild_dictionary
      WHERE guild_id = ?
        AND source = ?
    `,
    [
      guildId,
      source,
    ],
  );

  if (result.affectedRows === 0) {
    return null;
  }

  return {
    source,
    reading: null,
  };
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