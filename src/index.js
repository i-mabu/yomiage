require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");

const axios = require("axios");
const { Readable } = require("stream");

const {
  initDatabase,
  getUserSettings,
  setSpeaker,
  getGuildDictionary,
  upsertDictionaryEntry,
  deleteDictionaryEntry,
} = require("./database");

// ==================================================
// 環境変数
// ==================================================

if (!process.env.DISCORD_TOKEN) {
  throw new Error(
    "DISCORD_TOKEN が設定されていません。",
  );
}

if (!process.env.VOICEVOX_URL) {
  throw new Error(
    "VOICEVOX_URL が設定されていません。",
  );
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL が設定されていません。",
  );
}

// ==================================================
// 設定
// ==================================================

const SPEAKERS_PER_PAGE = 20;

// 1サーバーあたりの最大待機件数
const MAX_QUEUE_SIZE = 20;

// 1メッセージの最大文字数
const MAX_TEXT_LENGTH = 500;

// VCから人がいなくなってから切断するまで
const AUTO_LEAVE_DELAY = 3000;

// ==================================================
// Discord Client
// ==================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ==================================================
// Runtime State
// ==================================================

// guildId -> {
//   connection,
//   player,
//   textChannelId,
//   voiceChannelId
// }
const connectionMap = new Map();

// guildId -> [
//   {
//     userId,
//     username,
//     text
//   }
// ]
const speechQueues = new Map();

// guildId -> boolean
const speakingMap = new Map();

// guildId -> timeout
const autoLeaveTimers = new Map();

// ==================================================
// Queue
// ==================================================

function getQueue(guildId) {
  if (!speechQueues.has(guildId)) {
    speechQueues.set(guildId, []);
  }

  return speechQueues.get(guildId);
}

function clearSpeechQueue(guildId) {
  const queue = speechQueues.get(guildId);

  if (queue) {
    queue.length = 0;
  }

  speechQueues.delete(guildId);
  speakingMap.delete(guildId);

  console.log(
    `[TTS] guild=${guildId} キューをクリアしました。`,
  );
}

// ==================================================
// URL処理
// ==================================================

/**
 * URLを削除しつつ、
 * URLが含まれていたかを返す。
 *
 * 例:
 *
 * "こんにちは https://example.com"
 *
 * =>
 *
 * {
 *   text: "こんにちは",
 *   hasUrl: true
 * }
 */
function removeUrls(text) {
  let hasUrl = false;

  // Discordの自動リンク
  // <https://example.com>
  const discordUrlRegex =
    /<https?:\/\/[^>\s]+>/gi;

  if (discordUrlRegex.test(text)) {
    hasUrl = true;

    text = text.replace(
      discordUrlRegex,
      "",
    );
  }

  // 通常の http / https URL
  const urlRegex =
    /https?:\/\/[^\s<>"']+/gi;

  if (urlRegex.test(text)) {
    hasUrl = true;

    text = text.replace(
      urlRegex,
      "",
    );
  }

  // www.example.com
  const wwwRegex =
    /www\.[^\s<>"']+/gi;

  if (wwwRegex.test(text)) {
    hasUrl = true;

    text = text.replace(
      wwwRegex,
      "",
    );
  }

  // 余分な空白を整理
  text = text
    .replace(/\s+/g, " ")
    .trim();

  return {
    text,
    hasUrl,
  };
}

// ==================================================
// 顔文字
// ==================================================

function convertKaomoji(text) {
  const kaomojiMap = {
    "(´・ω・｀)": "しょんぼり",
    "(´・ω・`)": "しょんぼり",
    "(´；ω；｀)": "泣き",
    "(´；ω；`)": "泣き",
    "＼(^o^)／": "ばんざい",
    "（＾ω＾）": "にっこり",
    "(＾ω＾)": "にっこり",
    "ｗｗｗ": "笑い",
    "www": "笑い",
    "WWW": "笑い",
    "笑": "笑い",
  };

  for (
    const [kaomoji, reading]
    of Object.entries(kaomojiMap)
  ) {
    text = text.replaceAll(
      kaomoji,
      reading,
    );
  }

  return text;
}

// ==================================================
// メッセージ整形
// ==================================================

function sanitizeMessage(text) {
  const result =
    removeUrls(text);

  text = result.text;

  text =
    convertKaomoji(text);

  text = text
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // URLがあったことを通知
  if (result.hasUrl) {
    if (text) {
      text +=
        "、サイトURLが送信されました";
    } else {
      text =
        "サイトURLが送信されました";
    }
  }

  if (!text) {
    return "";
  }

  if (
    text.length >
    MAX_TEXT_LENGTH
  ) {
    text =
      text.substring(
        0,
        MAX_TEXT_LENGTH,
      ) + "。";
  }

  return text;
}

// ==================================================
// 辞典
// ==================================================

async function applyGuildDictionary(guildId, text) {
  const entries = await getGuildDictionary(guildId);

  for (const entry of entries) {
    if (!entry.source) {
      continue;
    }

    // DB側で表記の長い順に取得しているため、複合語を先に置換する。
    text = text.split(entry.source).join(entry.reading);
  }

  return text;
}

// ==================================================
// VOICEVOX
// ==================================================

async function getSpeakers() {
  const response =
    await axios.get(
      `${process.env.VOICEVOX_URL}/speakers`,
      {
        timeout: 10000,
      },
    );

  return response.data;
}

function findSpeakerStyle(
  speakers,
  styleId,
) {
  for (
    const speaker of speakers
  ) {
    for (
      const style of speaker.styles
    ) {
      if (
        Number(style.id) ===
        Number(styleId)
      ) {
        return {
          speaker,
          style,
        };
      }
    }
  }

  return null;
}

// ==================================================
// Voice Connection
// ==================================================

async function waitForVoiceConnection(
  connection,
) {
  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      15000,
    );

    return true;
  } catch (error) {
    console.error(
      "VoiceConnection Ready待機失敗:",
      error,
    );

    return false;
  }
}

// ==================================================
// Audio再生
// ==================================================

function playAndWait(
  player,
  resource,
) {
  return new Promise(
    (resolve, reject) => {
      let finished = false;

      const cleanup = () => {
        player.removeListener(
          AudioPlayerStatus.Idle,
          onIdle,
        );

        player.removeListener(
          "error",
          onError,
        );
      };

      const finish = () => {
        if (finished) {
          return;
        }

        finished = true;

        cleanup();

        resolve();
      };

      const onIdle = () => {
        finish();
      };

      const onError = (error) => {
        if (finished) {
          return;
        }

        finished = true;

        cleanup();

        reject(error);
      };

      player.once(
        AudioPlayerStatus.Idle,
        onIdle,
      );

      player.once(
        "error",
        onError,
      );

      try {
        player.play(resource);
      } catch (error) {
        onError(error);
      }
    },
  );
}

// ==================================================
// 読み上げキュー処理
// ==================================================

async function processSpeechQueue(
  guildId,
) {
  // すでに読み上げ中なら何もしない
  if (
    speakingMap.get(guildId)
  ) {
    return;
  }

  const queue =
    speechQueues.get(guildId);

  if (
    !queue ||
    queue.length === 0
  ) {
    return;
  }

  const state =
    connectionMap.get(guildId);

  if (!state) {
    queue.length = 0;
    return;
  }

  const item =
    queue.shift();

  if (
    !item ||
    !item.text
  ) {
    setImmediate(() => {
      processSpeechQueue(guildId);
    });

    return;
  }

  speakingMap.set(
    guildId,
    true,
  );

  try {
    const currentState =
      connectionMap.get(guildId);

    if (!currentState) {
      return;
    }

    // ----------------------------------------------
    // ユーザーごとの設定
    // ----------------------------------------------

    const settings =
      await getUserSettings(
        guildId,
        item.userId,
      );

      const speechText = await applyGuildDictionary(
        guildId,
        item.text,
      );

      console.log(
        `[TTS] ` +
        `[${item.username}] ` +
        `speaker=${settings.speaker} ` +
        `"${speechText}"`,
      );

    // ----------------------------------------------
    // Audio Query
    // ----------------------------------------------

    console.log(
      "[VOICEVOX] audio_query start",
    );

    const queryResponse =
      await axios.post(
        `${process.env.VOICEVOX_URL}/audio_query` +
        `?text=${encodeURIComponent(
          speechText,
        )}` +
          `&speaker=${settings.speaker}`,
        undefined,
        {
          timeout: 30000,
        },
      );

    const query =
      queryResponse.data;

    // ----------------------------------------------
    // 音声設定
    // ----------------------------------------------

    query.speedScale =
      Number(
        settings.speed_scale ?? 1.0,
      );

    query.pitchScale =
      Number(
        settings.pitch_scale ?? 0.0,
      );

    query.intonationScale =
      Number(
        settings.intonation_scale ?? 1.0,
      );

    query.volumeScale =
      Number(
        settings.volume_scale ?? 1.0,
      );

    // ----------------------------------------------
    // Synthesis
    // ----------------------------------------------

    console.log(
      "[VOICEVOX] synthesis start",
    );

    const synthesisResponse =
      await axios.post(
        `${process.env.VOICEVOX_URL}/synthesis` +
          `?speaker=${settings.speaker}`,
        query,
        {
          responseType:
            "arraybuffer",
          timeout: 60000,
        },
      );

    console.log(
      "[VOICEVOX] synthesis success",
    );

    // ----------------------------------------------
    // Audio Resource
    // ----------------------------------------------

    const buffer =
      Buffer.from(
        synthesisResponse.data,
      );

    const stream =
      Readable.from(buffer);

    const resource =
      createAudioResource(stream);

    // ----------------------------------------------
    // 再生完了まで待つ
    // ----------------------------------------------

    await playAndWait(
      currentState.player,
      resource,
    );

    console.log(
      `[TTS] 再生完了 [${item.username}]`,
    );
  } catch (error) {
    console.error(
      "読み上げエラー:",
      error.response?.data ??
        error.message ??
        error,
    );
  } finally {
    speakingMap.set(
      guildId,
      false,
    );

    // 次のメッセージを再生
    setImmediate(() => {
      processSpeechQueue(guildId);
    });
  }
}

// ==================================================
// Discord UI
// ==================================================

function createCharacterMenu(
  speakers,
  page,
  userId,
) {
  const totalPages =
    Math.max(
      1,
      Math.ceil(
        speakers.length /
          SPEAKERS_PER_PAGE,
      ),
    );

  const currentPage =
    Math.min(
      Math.max(page, 0),
      totalPages - 1,
    );

  const start =
    currentPage *
    SPEAKERS_PER_PAGE;

  const pageSpeakers =
    speakers.slice(
      start,
      start +
        SPEAKERS_PER_PAGE,
    );

  const options =
    pageSpeakers.map(
      (speaker, index) => ({
        label:
          speaker.name.slice(
            0,
            100,
          ),

        value: String(
          start + index,
        ),

        description:
          `${speaker.styles.length}種類のスタイル`,
      }),
    );

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        `voice_character:${userId}:${currentPage}`,
      )
      .setPlaceholder(
        "キャラクターを選択してください",
      )
      .addOptions(options);

  const menuRow =
    new ActionRowBuilder()
      .addComponents(menu);

  const buttons =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `voice_prev:${userId}:${currentPage}`,
          )
          .setLabel("前へ")
          .setStyle(
            ButtonStyle.Secondary,
          )
          .setDisabled(
            currentPage <= 0,
          ),

        new ButtonBuilder()
          .setCustomId(
            `voice_page:${userId}:${currentPage}`,
          )
          .setLabel(
            `${currentPage + 1} / ${totalPages}`,
          )
          .setStyle(
            ButtonStyle.Secondary,
          )
          .setDisabled(true),

        new ButtonBuilder()
          .setCustomId(
            `voice_next:${userId}:${currentPage}`,
          )
          .setLabel("次へ")
          .setStyle(
            ButtonStyle.Secondary,
          )
          .setDisabled(
            currentPage >=
              totalPages - 1,
          ),
      );

  return {
    rows: [
      menuRow,
      buttons,
    ],
  };
}

function createStyleMenu(
  speaker,
  userId,
) {
  const options =
    speaker.styles
      .slice(0, 25)
      .map(
        (style) => ({
          label:
            style.name.slice(
              0,
              100,
            ),

          value: String(
            style.id,
          ),
        }),
      );

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        `voice_style:${userId}`,
      )
      .setPlaceholder(
        "スタイルを選択してください",
      )
      .addOptions(options);

  return new ActionRowBuilder()
    .addComponents(menu);
}

// ==================================================
// /voice
// ==================================================

async function showVoiceSettings(
  interaction,
) {
  const guildId =
    interaction.guildId;

  const userId =
    interaction.user.id;

  if (!guildId) {
    return interaction.reply({
      content:
        "このコマンドはサーバー内で使用してください。",
      ephemeral: true,
    });
  }

  try {
    const speakers =
      await getSpeakers();

    const settings =
      await getUserSettings(
        guildId,
        userId,
      );

    const current =
      findSpeakerStyle(
        speakers,
        settings.speaker,
      );

    const currentVoice =
      current
        ? `${current.speaker.name} / ${current.style.name}`
        : `話者ID ${settings.speaker}`;

    const embed =
      new EmbedBuilder()
        .setTitle(
          "🎙 読み上げ音声設定",
        )
        .setDescription(
          [
            `現在の音声: **${currentVoice}**`,
            "",
            "キャラクターを選択してください。",
            "",
            "設定は **サーバー × ユーザー** 単位で保存されます。",
          ].join("\n"),
        );

    const ui =
      createCharacterMenu(
        speakers,
        0,
        userId,
      );

    return interaction.reply({
      embeds: [embed],
      components: ui.rows,
      ephemeral: true,
    });
  } catch (error) {
    console.error(
      "音声設定UIエラー:",
      error,
    );

    return interaction.reply({
      content:
        "VOICEVOXから話者一覧を取得できませんでした。",
      ephemeral: true,
    });
  }
}

// ==================================================
// Ready
// ==================================================

client.once(
  "ready",
  async () => {
    console.log(
      `${client.user.tag} がオンラインになりました！`,
    );

    try {
      await initDatabase();

      const commands = [
        {
          name: "join",
          description:
            "ボイスチャンネルに参加して読み上げを開始します",
        },
        {
          name: "leave",
          description:
            "ボイスチャンネルから切断します",
        },
        {
          name: "voice",
          description:
            "自分の読み上げ音声を設定します",
        },
        {
          name: "dict-add",
          description: "辞典に表記と読みを登録します",
          options: [
            {
              name: "source",
              description: "読み替える表記",
              type: 3,
              required: true,
            },
            {
              name: "reading",
              description: "VOICEVOXに送る読み",
              type: 3,
              required: true,
            },
          ],
        },
        {
          name: "dict-delete",
          description: "辞典から表記を削除します",
          options: [
            {
              name: "source",
              description: "削除する表記",
              type: 3,
              required: true,
            },
          ],
        },
        {
          name: "dict-list",
          description: "このサーバーの辞典を表示します",
        },
      ];

      await client.application.commands.set(
        commands,
      );

      console.log(
        "スラッシュコマンドの登録が完了しました。",
      );
    } catch (error) {
      console.error(
        "起動処理エラー:",
        error,
      );

      process.exit(1);
    }
  },
);

// ==================================================
// Interaction
// ==================================================

client.on(
  "interactionCreate",
  async (interaction) => {
    try {
      // ==================================================
      // Slash Command
      // ==================================================

      if (
        interaction.isChatInputCommand()
      ) {
        const {
          commandName,
          guildId,
          member,
          guild,
        } = interaction;

        // ----------------------------------------------
        // /join
        // ----------------------------------------------

        if (
          commandName === "join"
        ) {
          const voiceChannel =
            member?.voice?.channel;

          if (!voiceChannel) {
            return interaction.reply({
              content:
                "先にボイスチャンネルに入ってください！",
              ephemeral: true,
            });
          }

          // 既存タイマー解除
          const oldTimer =
            autoLeaveTimers.get(
              guildId,
            );

          if (oldTimer) {
            clearTimeout(oldTimer);

            autoLeaveTimers.delete(
              guildId,
            );
          }

          // 既存接続破棄
          const oldState =
            connectionMap.get(
              guildId,
            );

          if (oldState) {
            try {
              oldState.player.stop();
            } catch {}

            try {
              oldState.connection.destroy();
            } catch {}
          }

          clearSpeechQueue(
            guildId,
          );

          const connection =
            joinVoiceChannel({
              channelId:
                voiceChannel.id,

              guildId,

              adapterCreator:
                guild.voiceAdapterCreator,
            });

          const ready =
            await waitForVoiceConnection(
              connection,
            );

          if (!ready) {
            try {
              connection.destroy();
            } catch {}

            return interaction.reply({
              content:
                "VCへの接続に失敗しました。",
              ephemeral: true,
            });
          }

          const player =
            createAudioPlayer({
              behaviors: {
                noSubscriber:
                  NoSubscriberBehavior.Pause,
              },
            });

          connection.subscribe(
            player,
          );

          connectionMap.set(
            guildId,
            {
              connection,
              player,
              textChannelId:
                interaction.channelId,
              voiceChannelId:
                voiceChannel.id,
            },
          );

          console.log(
            `[VOICE] ` +
            `[${guild.name}] ` +
            `VC接続: ${voiceChannel.name}`,
          );

          return interaction.reply(
            "🔊 接続しました。このチャンネルの文字を読み上げます！",
          );
        }

        // ----------------------------------------------
        // /leave
        // ----------------------------------------------

        if (
          commandName === "leave"
        ) {
          const state =
            connectionMap.get(
              guildId,
            );

          clearSpeechQueue(
            guildId,
          );

          const timer =
            autoLeaveTimers.get(
              guildId,
            );

          if (timer) {
            clearTimeout(timer);

            autoLeaveTimers.delete(
              guildId,
            );
          }

          if (state) {
            try {
              state.player.stop();
            } catch {}

            try {
              state.connection.destroy();
            } catch {}

            connectionMap.delete(
              guildId,
            );

            return interaction.reply(
              "👋 切断しました。",
            );
          }

          return interaction.reply({
            content:
              "ボットはVCに参加していません。",
            ephemeral: true,
          });
        }

        // ----------------------------------------------
        // /voice
        // ----------------------------------------------

        if (
          commandName === "voice"
        ) {
          return showVoiceSettings(
            interaction,
          );
        }

        // ----------------------------------------------
        // /dict-add
        // ----------------------------------------------

        if (commandName === "dict-add") {
          if (!guildId) {
            return interaction.reply({
              content: "このコマンドはサーバー内で使用してください。",
              ephemeral: true,
            });
          }

          const source = interaction.options.getString("source", true).trim();
          const reading = interaction.options.getString("reading", true).trim();

          if (!source || !reading || source.length > 100 || reading.length > 100) {
            return interaction.reply({
              content: "表記と読みは1〜100文字で指定してください。",
              ephemeral: true,
            });
          }

          await upsertDictionaryEntry(guildId, source, reading);
          return interaction.reply({
            content: `辞典に登録しました。\n「${source}」→「${reading}」`,
            ephemeral: true,
          });
        }

        // ----------------------------------------------
        // /dict-delete
        // ----------------------------------------------

        if (commandName === "dict-delete") {
          if (!guildId) {
            return interaction.reply({
              content: "このコマンドはサーバー内で使用してください。",
              ephemeral: true,
            });
          }

          const source = interaction.options.getString("source", true).trim();
          const deleted = await deleteDictionaryEntry(guildId, source);

          return interaction.reply({
            content: deleted
              ? `辞典から削除しました。\n「${deleted.source}」→「${deleted.reading}」`
              : `辞典に「${source}」は登録されていません。`,
            ephemeral: true,
          });
        }

        // ----------------------------------------------
        // /dict-list
        // ----------------------------------------------

        if (commandName === "dict-list") {
          if (!guildId) {
            return interaction.reply({
              content: "このコマンドはサーバー内で使用してください。",
              ephemeral: true,
            });
          }

          const entries = await getGuildDictionary(guildId);
          const content = entries.length === 0
            ? "このサーバーの辞典は空です。"
            : [
                "このサーバーの辞典:",
                ...entries.map((entry) => `「${entry.source}」→「${entry.reading}」`),
              ].join("\n").slice(0, 1900);

          return interaction.reply({
            content,
            ephemeral: true,
          });
        }

        return;
      }

      // ==================================================
      // Select Menu
      // ==================================================

      if (
        interaction.isStringSelectMenu()
      ) {
        const customId =
          interaction.customId;

        // ----------------------------------------------
        // キャラクター
        // ----------------------------------------------

        if (
          customId.startsWith(
            "voice_character:",
          )
        ) {
          const [
            ,
            userId,
          ] =
            customId.split(":");

          if (
            interaction.user.id !==
            userId
          ) {
            return interaction.reply({
              content:
                "この設定画面はあなたのものではありません。",
              ephemeral: true,
            });
          }

          const speakerIndex =
            Number(
              interaction.values[0],
            );

          const speakers =
            await getSpeakers();

          const speaker =
            speakers[
              speakerIndex
            ];

          if (!speaker) {
            return interaction.reply({
              content:
                "キャラクターが見つかりませんでした。",
              ephemeral: true,
            });
          }

          const styleMenu =
            createStyleMenu(
              speaker,
              userId,
            );

          const embed =
            new EmbedBuilder()
              .setTitle(
                "🎙 スタイルを選択",
              )
              .setDescription(
                [
                  `キャラクター: **${speaker.name}**`,
                  "",
                  "読み上げに使用するスタイルを選択してください。",
                ].join("\n"),
              );

          return interaction.update({
            embeds: [embed],
            components: [
              styleMenu,
            ],
          });
        }

        // ----------------------------------------------
        // スタイル
        // ----------------------------------------------

        if (
          customId.startsWith(
            "voice_style:",
          )
        ) {
          const [
            ,
            userId,
          ] =
            customId.split(":");

          if (
            interaction.user.id !==
            userId
          ) {
            return interaction.reply({
              content:
                "この設定画面はあなたのものではありません。",
              ephemeral: true,
            });
          }

          const speakerId =
            Number(
              interaction.values[0],
            );

          await setSpeaker(
            interaction.guildId,
            interaction.user.id,
            speakerId,
          );

          const speakers =
            await getSpeakers();

          const selected =
            findSpeakerStyle(
              speakers,
              speakerId,
            );

          const voiceName =
            selected
              ? `${selected.speaker.name} / ${selected.style.name}`
              : `話者ID ${speakerId}`;

          const embed =
            new EmbedBuilder()
              .setTitle(
                "✅ 読み上げ音声を変更しました",
              )
              .setDescription(
                [
                  `音声: **${voiceName}**`,
                  "",
                  "このサーバーでのあなたの読み上げ設定として保存されました。",
                ].join("\n"),
              );

          return interaction.update({
            embeds: [embed],
            components: [],
          });
        }

        return;
      }

      // ==================================================
      // Buttons
      // ==================================================

      if (
        interaction.isButton()
      ) {
        const customId =
          interaction.customId;

        if (
          customId.startsWith(
            "voice_prev:",
          ) ||
          customId.startsWith(
            "voice_next:",
          )
        ) {
          const [
            action,
            userId,
            pageText,
          ] =
            customId.split(":");

          if (
            interaction.user.id !==
            userId
          ) {
            return interaction.reply({
              content:
                "この設定画面はあなたのものではありません。",
              ephemeral: true,
            });
          }

          let page =
            Number(pageText);

          if (
            action ===
            "voice_prev"
          ) {
            page--;
          } else {
            page++;
          }

          const speakers =
            await getSpeakers();

          const ui =
            createCharacterMenu(
              speakers,
              page,
              userId,
            );

          return interaction.update({
            components:
              ui.rows,
          });
        }
      }
    } catch (error) {
      console.error(
        "Interaction処理エラー:",
        error,
      );

      try {
        if (
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content:
              "処理中にエラーが発生しました。",
            ephemeral: true,
          });
        }
      } catch {}
    }
  },
);

// ==================================================
// Message Create
// ==================================================

client.on(
  "messageCreate",
  async (message) => {
    try {
      // Bot除外
      if (
        message.author.bot
      ) {
        return;
      }

      if (
        !message.content
      ) {
        return;
      }

      if (
        !message.guildId
      ) {
        return;
      }

      console.log(
        `[MESSAGE] ` +
        `[${message.guild.name}] ` +
        `${message.author.tag}: ` +
        `"${message.content}"`,
      );

      // ----------------------------------------------
      // VC接続確認
      // ----------------------------------------------

      const state =
        connectionMap.get(
          message.guildId,
        );

      if (!state) {
        return;
      }

      // ----------------------------------------------
      // /joinしたテキストチャンネルだけ
      // ----------------------------------------------

      if (
        message.channelId !==
        state.textChannelId
      ) {
        return;
      }

      // ----------------------------------------------
      // Slash command除外
      // ----------------------------------------------

      if (
        message.content.startsWith("/")
      ) {
        return;
      }

      let text =
        message.content;

      // ----------------------------------------------
      // Mention変換
      // ----------------------------------------------

      if (
        message.mentions.users.size >
        0
      ) {
        text = text.replace(
          /<@!?(\d+)>/g,
          (_, userId) => {
            const member =
              message.guild?.members.cache.get(
                userId,
              );

            return (
              member?.displayName ??
              message.client.users.cache.get(
                userId,
              )?.username ??
              "ユーザー"
            );
          },
        );
      }

      // ----------------------------------------------
      // URL除去 + 「サイトURL」
      // ----------------------------------------------

      text =
        sanitizeMessage(text);

      // ----------------------------------------------
      // 空文字ならスキップ
      // ----------------------------------------------

      if (!text) {
        return;
      }

      // ----------------------------------------------
      // キュー取得
      // ----------------------------------------------

      const queue =
        getQueue(
          message.guildId,
        );

      // ----------------------------------------------
      // キュー上限
      // ----------------------------------------------

      if (
        queue.length >=
        MAX_QUEUE_SIZE
      ) {
        console.log(
          `[TTS] ` +
          `キュー上限(${MAX_QUEUE_SIZE}) ` +
          `のためスキップしました。`,
        );

        return;
      }

      // ----------------------------------------------
      // キュー追加
      // ----------------------------------------------

      queue.push({
        userId:
          message.author.id,

        username:
          message.author.tag,

        text,
      });

      console.log(
        `[TTS QUEUE] ` +
        `追加: ${message.author.tag} ` +
        `queue=${queue.length} ` +
        `"${text}"`,
      );

      // ----------------------------------------------
      // 再生開始
      // ----------------------------------------------

      processSpeechQueue(
        message.guildId,
      );
    } catch (error) {
      console.error(
        "messageCreateエラー:",
        error,
      );
    }
  },
);

// ==================================================
// Voice State Update
// ==================================================

client.on(
  "voiceStateUpdate",
  (oldState, newState) => {
    const guildId =
      oldState.guild.id;

    const state =
      connectionMap.get(
        guildId,
      );

    if (!state) {
      return;
    }

    // ----------------------------------------------
    // Bot自身
    // ----------------------------------------------

    if (
      newState.member?.user?.id ===
      client.user.id
    ) {
      if (
        newState.channelId ===
        null
      ) {
        console.log(
          "[VOICE] BotがVCから切断されました。",
        );

        clearSpeechQueue(
          guildId,
        );

        connectionMap.delete(
          guildId,
        );
      }

      return;
    }

    // ----------------------------------------------
    // 対象VC以外
    // ----------------------------------------------

    if (
      oldState.channelId !==
      state.voiceChannelId
    ) {
      return;
    }

    const channel =
      oldState.channel;

    if (!channel) {
      return;
    }

    // ----------------------------------------------
    // 人間ユーザー数
    // ----------------------------------------------

    const humanMembers =
      channel.members.filter(
        (member) =>
          !member.user.bot,
      );

    // 人が残っている
    if (
      humanMembers.size > 0
    ) {
      const timer =
        autoLeaveTimers.get(
          guildId,
        );

      if (timer) {
        clearTimeout(timer);

        autoLeaveTimers.delete(
          guildId,
        );
      }

      return;
    }

    // ----------------------------------------------
    // 人がいなくなった
    // ----------------------------------------------

    console.log(
      `[VOICE] ` +
      `[${oldState.guild.name}] ` +
      "VCから人がいなくなりました。",
    );

    const oldTimer =
      autoLeaveTimers.get(
        guildId,
      );

    if (oldTimer) {
      clearTimeout(oldTimer);
    }

    const timer =
      setTimeout(() => {
        autoLeaveTimers.delete(
          guildId,
        );

        const currentState =
          connectionMap.get(
            guildId,
          );

        if (!currentState) {
          return;
        }

        const freshChannel =
          oldState.guild.channels.cache.get(
            currentState.voiceChannelId,
          );

        if (!freshChannel) {
          return;
        }

        const freshHumans =
          freshChannel.members.filter(
            (member) =>
              !member.user.bot,
          );

        // 誰か戻ってきた
        if (
          freshHumans.size > 0
        ) {
          return;
        }

        console.log(
          `[VOICE] ` +
          `[${oldState.guild.name}] ` +
          "人がいないため自動切断します。",
        );

        // 再生停止
        try {
          currentState.player.stop();
        } catch {}

        // キュー削除
        clearSpeechQueue(
          guildId,
        );

        // 切断
        try {
          currentState.connection.destroy();
        } catch {}

        connectionMap.delete(
          guildId,
        );
      }, AUTO_LEAVE_DELAY);

    autoLeaveTimers.set(
      guildId,
      timer,
    );
  },
);

// ==================================================
// Discord Error
// ==================================================

client.on(
  "error",
  (error) => {
    console.error(
      "Discord Client Error:",
      error,
    );
  },
);

// ==================================================
// Process Error
// ==================================================

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled Promise Rejection:",
      error,
    );
  },
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught Exception:",
      error,
    );
  },
);

// ==================================================
// Login
// ==================================================

client.login(
  process.env.DISCORD_TOKEN,
);