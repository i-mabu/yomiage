require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  ApplicationCommandOptionType,
  ChannelType,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection,
} = require("@discordjs/voice");
const axios = require("axios");
const { Readable } = require("stream");

// クライアントの作成（GuildMembers と VoiceStates を追加）
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// 各サーバーのプレイヤーや状態を管理するマップ
const connectionMap = new Map();

function convertKaomoji(text) {
  const kaomojiMap = {
    "(´・ω・｀)": "しょんぼり",
    "(´・ω・`)": "しょんぼり",
    "(´；ω；｀)": "泣き",
    "(´；ω；`)": "泣き",
    "＼(^o^)／": "ばんざい",
    "（＾ω＾）": "にっこり",
    "(＾ω＾)": "にっこり",
    ｗｗｗ: "笑い",
    www: "笑い",
    WWW: "笑い",
    笑: "笑い",
  };

  for (const [kaomoji, reading] of Object.entries(kaomojiMap)) {
    text = text.replaceAll(kaomoji, reading);
  }

  return text;
}

client.once("ready", async () => {
  console.log(`${client.user.tag} がオンラインになりました！`);

  // グローバルにスラッシュコマンドを登録
  const commands = [
    {
      name: "join",
      description: "ボイスチャンネルに参加して読み上げを開始します",
    },
    {
      name: "leave",
      description: "ボイスチャンネルから切断します",
    },
  ];

  await client.application.commands.set(commands);
  console.log("スラッシュコマンドの登録が完了しました。");
});

// --- スラッシュコマンドの処理 ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member, guild } = interaction;

  // /join コマンド
  if (commandName === "join") {
    const voiceChannel = member?.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: "先にボイスチャンネルに入ってください！",
        ephemeral: true,
      });
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    connection.subscribe(player);

    // テキストを読み上げる対象のチャンネルIDも一緒に保存
    connectionMap.set(guildId, {
      connection,
      player,
      textChannelId: interaction.channelId,
      voiceChannelId: voiceChannel.id,
    });

    return interaction.reply(
      "接続しました。このチャンネルの文字を読み上げます！",
    );
  }

  // /leave コマンド
  if (commandName === "leave") {
    const state = connectionMap.get(guildId);
    if (state) {
      state.connection.destroy();
      connectionMap.delete(guildId);
      return interaction.reply("切断しました。");
    }
    return interaction.reply({
      content: "ボットはVCに参加していません。",
      ephemeral: true,
    });
  }
});

// --- 通常メッセージの読み上げ処理 ---
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content) return;

  const state = connectionMap.get(message.guildId);
  // /join したテキストチャンネルと同じ場所のチャットのみ読み上げる
  if (state && message.channelId === state.textChannelId) {
    // スラッシュコマンド（/）から始まる文章は読み飛ばす
    if (message.content.startsWith("/")) return;

    let text = message.content;

    // メンションがある場合だけ、メンションを表示名に変換
    if (message.mentions.users.size > 0) {
      text = text.replace(/<@!?(\d+)>/g, (_, userId) => {
        const member = message.guild?.members.cache.get(userId);

        return (
          member?.displayName ??
          message.client.users.cache.get(userId)?.username ??
          "ユーザー"
        );
      });
    }

    // 顔文字を読み上げ向けに変換
    text = convertKaomoji(text);

    try {
      const queryResponse = await axios.post(
        `${process.env.VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=3`,
      );

      const synthesisResponse = await axios.post(
        `${process.env.VOICEVOX_URL}/synthesis?speaker=3`,
        queryResponse.data,
        { responseType: "arraybuffer" },
      );

      const buffer = Buffer.from(synthesisResponse.data);
      const stream = Readable.from(buffer);
      const resource = createAudioResource(stream);

      state.player.play(resource);
    } catch (error) {
      console.error("読み上げエラー:", error);
    }
  }
});

// --- ボットのみになったら自動切断する処理 ---
client.on("voiceStateUpdate", (oldState, newState) => {
  // 誰かがVCから退出した、またはチャンネルを移動した場合のみチェック
  if (!oldState.channelId) return;

  const guildId = oldState.guild.id;
  const state = connectionMap.get(guildId);

  // ボットがそのサーバーで稼イド中かつ、ボットがいるVCで動きがあったか
  if (state && state.voiceChannelId === oldState.channelId) {
    const channel = oldState.channel;
    if (!channel) return;

    // チャンネル内にいる「Botではない人間」の数をカウント
    const humanMembers = channel.members.filter((member) => !member.user.bot);

    // 人間が0人になった場合
    if (humanMembers.size === 0) {
      // 3秒ほど待って、本当に誰もいなければ切断（誤検知・瞬断対策）
      setTimeout(() => {
        const currentConnection = getVoiceConnection(guildId);
        if (currentConnection) {
          // 最新のチャンネル状態を再取得して、まだ0人か確認
          const freshChannel = oldState.guild.channels.cache.get(
            state.voiceChannelId,
          );
          if (freshChannel) {
            const freshHumans = freshChannel.members.filter((m) => !m.user.bot);
            if (freshHumans.size === 0) {
              currentConnection.destroy();
              connectionMap.delete(guildId);
              console.log(
                `[${oldState.guild.name}] 人がいなくなったため自動切断しました。`,
              );
            }
          }
        }
      }, 3000);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
