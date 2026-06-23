// ============================================================================
//  POPPY BOT - index.js
//  Discord.js v14 / Node.js 18+
//
//  Fonctionnalites :
//   1. Systeme de co-proprietaires (prefixe "+")
//   2. +say  -> envoie un bouton qui ouvre le modal d'embed, publie avec @everyone
//   3. +dashboard -> panneau de config interactif (boutons + modals)
//   4. Alertes live automatiques Twitch (API officielle) + TikTok (WebSocket temps reel)
//   5. Systeme de bienvenue personnalise (guildMemberAdd)
//
//  Persistance : owners.json + config.json
// ============================================================================

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

// ----------------------------------------------------------------------------
//  CONSTANTES / FICHIERS
// ----------------------------------------------------------------------------
const PREFIX = '+';
const OWNERS_FILE = path.join(__dirname, 'owners.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LIVE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ----------------------------------------------------------------------------
//  HELPERS DE PERSISTANCE
// ----------------------------------------------------------------------------

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.warn(`[WARN] Lecture de ${path.basename(file)} impossible, valeur par defaut utilisee.`);
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getOwners() {
  const data = readJSON(OWNERS_FILE, { owners: [] });
  return Array.isArray(data.owners) ? data.owners : [];
}
function setOwners(owners) {
  writeJSON(OWNERS_FILE, { owners });
}

function getConfig() {
  return readJSON(CONFIG_FILE, {
    alertChannelId: '',
    welcomeChannelId: '',
    welcomeImageUrl: '',
    twitchUsername: '',
    tiktokUsername: '',
    livePingType: 'everyone',  // everyone | here | role | aucun
    livePingRoleId: '',        // ID du role si livePingType = 'role'
    liveAlertImageUrl: '',     // Image affichee dans les embeds d'alerte live
  });
}
function setConfig(patch) {
  const config = { ...getConfig(), ...patch };
  writeJSON(CONFIG_FILE, config);
  return config;
}

// ----------------------------------------------------------------------------
//  HELPERS DE PERMISSIONS
// ----------------------------------------------------------------------------

function isServerOwner(guild, userId) {
  return guild && guild.ownerId === userId;
}

function isOwnerOrCoOwner(guild, userId) {
  return isServerOwner(guild, userId) || getOwners().includes(userId);
}

function parseUserId(input) {
  if (!input) return null;
  const match = input.match(/^(?:<@!?)?(\d{17,20})>?$/);
  return match ? match[1] : null;
}

function parseHexColor(input, fallback = 0x9b59b6) {
  if (!input) return fallback;
  const clean = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return parseInt(clean, 16);
  return fallback;
}

function isValidUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim());
}

/**
 * Construit le contenu et allowedMentions du ping d'alerte live
 * selon la config (everyone / here / role / aucun).
 */
function buildLivePing(config) {
  const type   = config.livePingType   || 'everyone';
  const roleId = config.livePingRoleId || '';
  if (type === 'here')           return { content: '@here',          allowedMentions: { parse: ['here'] } };
  if (type === 'role' && roleId) return { content: `<@&${roleId}>`, allowedMentions: { roles: [roleId] } };
  if (type === 'aucun')          return { content: '',               allowedMentions: { parse: [] } };
  return { content: '@everyone', allowedMentions: { parse: ['everyone'] } };
}

// ----------------------------------------------------------------------------
//  SYSTEME DE FONTS UNICODE (applique au titre de l'embed)
// ----------------------------------------------------------------------------

// Chaque chaine contient 26 caracteres Unicode correspondant a A-Z ou a-z.
// Ces caracteres sont des "surrogate pairs" (2 octets) donc on utilise Array.from().
const FONT_ALPHABETS = {
  bold: {
    upper:  '𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭',
    lower:  '𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇',
    digits: '𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵',
  },
  italic: {
    upper:  '𝘈𝘉𝘊𝘋𝘌𝘍𝘎𝘏𝘐𝘑𝘒𝘓𝘔𝘕𝘖𝘗𝘘𝘙𝘚𝘛𝘜𝘝𝘞𝘟𝘠𝘡',
    lower:  '𝘢𝘣𝘤𝘥𝘦𝘧𝘨𝘩𝘪𝘫𝘬𝘭𝘮𝘯𝘰𝘱𝘲𝘳𝘴𝘵𝘶𝘷𝘸𝘹𝘺𝘻',
    digits: null,
  },
  script: {
    upper:  '𝓐𝓑𝓒𝓓𝓔𝓕𝓖𝓗𝓘𝓙𝓚𝓛𝓜𝓝𝓞𝓟𝓠𝓡𝓢𝓣𝓤𝓥𝓦𝓧𝓨𝓩',
    lower:  '𝓪𝓫𝓬𝓭𝓮𝓯𝓰𝓱𝓲𝓳𝓴𝓵𝓶𝓷𝓸𝓹𝓺𝓻𝓼𝓽𝓾𝓿𝔀𝔁𝔂𝔃',
    digits: null,
  },
  gothic: {
    upper:  '𝔄𝔅ℭ𝔇𝔈𝔉𝔊ℌℑ𝔍𝔎𝔏𝔐𝔑𝔒𝔓𝔔ℜ𝔖𝔗𝔘𝔙𝔚𝔛𝔜ℨ',
    lower:  '𝔞𝔟𝔠𝔡𝔢𝔣𝔤𝔥𝔦𝔧𝔨𝔩𝔪𝔫𝔬𝔭𝔮𝔯𝔰𝔱𝔲𝔳𝔴𝔵𝔶𝔷',
    digits: null,
  },
  double: {
    upper:  '𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ',
    lower:  '𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫',
    digits: '𝟘𝟙𝟚𝟛𝟜𝟝𝟞𝟟𝟠𝟡',
  },
  mono: {
    upper:  '𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉',
    lower:  '𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣',
    digits: '𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿',
  },
};

const FONT_LABELS = {
  normal: 'Normal', bold: 'Gras', italic: 'Italique',
  script: 'Script', gothic: 'Gothique', double: 'Double-trait', mono: 'Monospace',
};

/** Transforme le texte ASCII en police Unicode mathematique (applique au titre). */
function applyFont(text, fontName) {
  if (!text || fontName === 'normal' || !FONT_ALPHABETS[fontName]) return text;
  const { upper, lower, digits } = FONT_ALPHABETS[fontName];
  const U = Array.from(upper);
  const L = Array.from(lower);
  const D = digits ? Array.from(digits) : null;
  return Array.from(text).map((char) => {
    const c = char.charCodeAt(0);
    if (c >= 65 && c <= 90)  return U[c - 65]  ?? char;
    if (c >= 97 && c <= 122) return L[c - 97]  ?? char;
    if (D && c >= 48 && c <= 57) return D[c - 48] ?? char;
    return char;
  }).join('');
}

// Etat temporaire par utilisateur pour le flux +say : { channelId, font }
const sayState = new Map();

// ----------------------------------------------------------------------------
//  CLIENT DISCORD
// ----------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,   // Privileged Intent — activer dans le Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Privileged Intent — activer dans le Developer Portal
  ],
  partials: [Partials.Channel],
});

// ============================================================================
//  1. SYSTEME DE CO-PROPRIETAIRES (prefixe "+")
// ============================================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || '').toLowerCase();

  // ---- +say ----
  if (command === 'say') {
    if (!isOwnerOrCoOwner(message.guild, message.author.id)) {
      return message.reply('⛔ Cette commande est reservee aux owners.');
    }

    const channelRow = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('say_channel_select')
        .setPlaceholder('📌 Choisir le salon de publication...'),
    );

    const fontRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('say_font_select')
        .setPlaceholder('🔤 Style de police du titre...')
        .addOptions([
          { label: 'Normal',       value: 'normal',  description: 'Texte standard',              emoji: '🔤' },
          { label: 'Gras',         value: 'bold',    description: '𝗚𝗿𝗮𝘀 (sans-serif bold)',       emoji: '✏️' },
          { label: 'Italique',     value: 'italic',  description: '𝘐𝘵𝘢𝘭𝘪𝘲𝘶𝘦 (sans-serif italic)', emoji: '📐' },
          { label: 'Script',       value: 'script',  description: '𝓢𝓬𝓻𝓲𝓹𝓽 (cursive bold)',        emoji: '🖋️' },
          { label: 'Gothique',     value: 'gothic',  description: '𝔊𝔬𝔱𝔥𝔦𝔮𝔲𝔢 (fraktur)',           emoji: '🏰' },
          { label: 'Double-trait', value: 'double',  description: '𝔻𝕠𝕦𝕓𝕝𝕖-𝕥𝕣𝕒𝕚𝕥',               emoji: '🔡' },
          { label: 'Monospace',    value: 'mono',    description: '𝙼𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎 (code)',             emoji: '💻' },
        ]),
    );

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('say_open')
        .setLabel("Ouvrir l'editeur d'embed")
        .setEmoji('📝')
        .setStyle(ButtonStyle.Primary),
    );

    message.delete().catch(() => {});

    const prompt = await message.channel.send({
      content: `📢 **Publication d'un embed**\n📌 **Salon :** <#${message.channelId}> *(change ci-dessous)*\n🔤 **Police :** Normal`,
      components: [channelRow, fontRow, buttonRow],
    });

    sayState.set(message.author.id, {
      channelId: message.channelId,
      font: 'normal',
      promptId: prompt.id,
      promptChannelId: prompt.channelId,
    });
    return;
  }

  // ---- +dashboard : affiche le panneau de config ----
  if (command === 'dashboard') {
    if (!isOwnerOrCoOwner(message.guild, message.author.id)) {
      return message.reply('⛔ Cette commande est reservee aux owners.');
    }
    const { embed, rows } = buildDashboard();
    return message.reply({ embeds: [embed], components: rows });
  }

  if (command !== 'owner') return;

  const sub = (args.shift() || '').toLowerCase();
  const guild = message.guild;

  // +owner list : createur OU co-proprietaire
  if (sub === 'list') {
    if (!isOwnerOrCoOwner(guild, message.author.id)) {
      return message.reply("⛔ Tu n'es pas autorise a utiliser cette commande.");
    }
    const owners = getOwners();
    const list = owners.length
      ? owners.map((id, i) => `\`${i + 1}.\` <@${id}> (\`${id}\`)`).join('\n')
      : '*Aucun co-proprietaire enregistre.*';

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('👑 Co-proprietaires autorises')
      .setDescription(`**Createur originel :** <@${guild.ownerId}>\n\n**Co-proprietaires :**\n${list}`)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // +owner add / remove : TOI UNIQUEMENT (SUPER_OWNER_ID dans .env)
  if (sub === 'add' || sub === 'remove') {
    if (message.author.id !== process.env.SUPER_OWNER_ID) {
      return message.reply('⛔ Seul le super-owner peut ajouter ou retirer un co-proprietaire.');
    }

    const targetId = parseUserId(args[0]);
    if (!targetId) {
      return message.reply(`❌ Utilisation : \`${PREFIX}owner ${sub} @mention\` (ou un ID valide).`);
    }
    if (targetId === guild.ownerId) {
      return message.reply('ℹ️ Le createur originel est deja proprietaire par defaut.');
    }

    const owners = getOwners();
    if (sub === 'add') {
      if (owners.includes(targetId)) return message.reply('⚠️ Cette personne est deja co-proprietaire.');
      owners.push(targetId);
      setOwners(owners);
      return message.reply(`✅ <@${targetId}> a ete ajoute aux co-proprietaires.`);
    } else {
      if (!owners.includes(targetId)) return message.reply("⚠️ Cette personne n'est pas dans la liste des co-proprietaires.");
      setOwners(owners.filter((id) => id !== targetId));
      return message.reply(`✅ <@${targetId}> a ete retire des co-proprietaires.`);
    }
  }

  return message.reply(
    [
      '**Commandes owner :**',
      `\`${PREFIX}owner add @mention\` — ajouter un co-proprietaire (createur uniquement)`,
      `\`${PREFIX}owner remove @mention\` — retirer un co-proprietaire (createur uniquement)`,
      `\`${PREFIX}owner list\` — afficher la liste`,
    ].join('\n'),
  );
});

// ============================================================================
//  GESTION DES INTERACTIONS (boutons, modals)
// ============================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---- Selecteur de salon natif (flux +say) ----
    if (interaction.isChannelSelectMenu() && interaction.customId === 'say_channel_select') {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ content: '⛔ Action reservee aux owners.', flags: MessageFlags.Ephemeral });
      }
      const state = sayState.get(interaction.user.id) ?? { channelId: interaction.channelId, font: 'normal' };
      state.channelId = interaction.values[0];
      sayState.set(interaction.user.id, state);

      const font = FONT_LABELS[state.font] ?? 'Normal';
      return interaction.update({
        content: `📢 **Publication d'un embed**\n📌 **Salon :** <#${state.channelId}>\n🔤 **Police :** ${font}`,
      });
    }

    // ---- Menu de selection de la police (flux +say) ----
    if (interaction.isStringSelectMenu() && interaction.customId === 'say_font_select') {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ content: '⛔ Action reservee aux owners.', flags: MessageFlags.Ephemeral });
      }
      const state = sayState.get(interaction.user.id) ?? { channelId: null, font: 'normal' };
      state.font = interaction.values[0];
      sayState.set(interaction.user.id, state);

      return interaction.update({
        content: `📢 **Publication d'un embed**\n📌 **Salon :** <#${state.channelId ?? interaction.channelId}>\n🔤 **Police :** ${FONT_LABELS[state.font] ?? 'Normal'}`,
      });
    }

    if (interaction.isButton()) {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ content: '⛔ Action reservee aux owners.', flags: MessageFlags.Ephemeral });
      }
      switch (interaction.customId) {
        case 'say_open':           return interaction.showModal(buildSayModal());
        case 'dash_channels':      return interaction.showModal(buildChannelsModal());
        case 'dash_streams':       return interaction.showModal(buildStreamsModal());
        case 'dash_welcome_image': return interaction.showModal(buildWelcomeImageModal());
        case 'dash_ping':          return interaction.showModal(buildPingModal());
        case 'dash_refresh': {
          const { embed, rows } = buildDashboard();
          return interaction.update({ embeds: [embed], components: rows });
        }
      }
    }

    if (interaction.isModalSubmit()) {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ content: '⛔ Action reservee aux owners.', flags: MessageFlags.Ephemeral });
      }
      if (interaction.customId === 'say_modal')          return handleSayModal(interaction);
      if (interaction.customId === 'channels_modal')     return handleChannelsModal(interaction);
      if (interaction.customId === 'streams_modal')      return handleStreamsModal(interaction);
      if (interaction.customId === 'welcome_image_modal') return handleWelcomeImageModal(interaction);
      if (interaction.customId === 'ping_modal')          return handlePingModal(interaction);
    }
  } catch (err) {
    console.error('[ERREUR] Interaction :', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: '❌ Une erreur est survenue.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ============================================================================
//  2. /say — EDITEUR D'EMBED
// ============================================================================
function buildSayModal() {
  return new ModalBuilder()
    .setCustomId('say_modal')
    .setTitle("Editeur d'embed")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('title').setLabel('Titre')
          .setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('description').setLabel('Description (Markdown supporte)')
          .setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('color').setLabel('Couleur hexadecimale (ex: #9b59b6)')
          .setStyle(TextInputStyle.Short).setPlaceholder('#9b59b6').setMaxLength(7).setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('footer').setLabel('Texte du footer')
          .setStyle(TextInputStyle.Short).setMaxLength(2048).setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('image').setLabel("URL de l'image")
          .setStyle(TextInputStyle.Short).setPlaceholder('https://...').setRequired(false),
      ),
    );
}

async function handleSayModal(interaction) {
  // Recupere l'etat (font + canal cible) stocke par +say, puis le supprime
  const state = sayState.get(interaction.user.id) ?? { channelId: null, font: 'normal' };
  sayState.delete(interaction.user.id);

  const rawTitle    = interaction.fields.getTextInputValue('title')?.trim();
  const description = interaction.fields.getTextInputValue('description')?.trim();
  const color       = parseHexColor(interaction.fields.getTextInputValue('color'));
  const footer      = interaction.fields.getTextInputValue('footer')?.trim();
  const image       = interaction.fields.getTextInputValue('image')?.trim();

  // Applique la police Unicode choisie au titre uniquement
  const title = applyFont(rawTitle, state.font ?? 'normal');

  const embed = new EmbedBuilder().setColor(color).setDescription(description || '​');
  if (title)                      embed.setTitle(title);
  if (footer)                     embed.setFooter({ text: footer });
  if (image && isValidUrl(image)) embed.setImage(image);

  // Salon cible : celui specifie dans +say, ou le salon courant
  let targetChannel = interaction.channel;
  if (state.channelId) {
    try { targetChannel = await client.channels.fetch(state.channelId); } catch {
      return interaction.reply({ content: `❌ Salon introuvable (\`${state.channelId}\`).`, flags: MessageFlags.Ephemeral });
    }
  }

  await targetChannel.send({
    content: '@everyone',
    embeds: [embed],
    allowedMentions: { parse: ['everyone'] },
  });

  // Supprime le message de selection (sélecteur de police + bouton)
  if (state.promptId) {
    try {
      const promptChannel = await client.channels.fetch(state.promptChannelId ?? interaction.channelId);
      const promptMsg = await promptChannel.messages.fetch(state.promptId);
      await promptMsg.delete();
    } catch {}
  }

  return interaction.reply({ content: `✅ Embed publie dans <#${targetChannel.id}>.`, flags: MessageFlags.Ephemeral });
}

// ============================================================================
//  3. /dashboard — TABLEAU DE BORD
// ============================================================================
function buildDashboard() {
  const config = getConfig();
  const fmtChannel = (id) => (id ? `<#${id}> (\`${id}\`)` : '`non configure`');
  const fmtText    = (v)  => (v  ? `\`${v}\``            : '`non configure`');

  const fmtPing = (cfg) => {
    if (cfg.livePingType === 'here')                          return '`@here`';
    if (cfg.livePingType === 'role' && cfg.livePingRoleId)   return `<@&${cfg.livePingRoleId}> (role)`;
    if (cfg.livePingType === 'aucun')                         return '`Aucun ping`';
    return '`@everyone`';
  };

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('⚙️ Tableau de bord')
    .setDescription('Configuration actuelle du bot. Utilise les boutons pour modifier.')
    .addFields(
      { name: '📌 Salon des alertes',  value: fmtChannel(config.alertChannelId),   inline: false },
      { name: '👋 Salon de bienvenue', value: fmtChannel(config.welcomeChannelId), inline: false },
      { name: '💜 Twitch suivi',       value: fmtText(config.twitchUsername),       inline: true  },
      { name: '🎵 TikTok suivi',       value: fmtText(config.tiktokUsername),       inline: true  },
      { name: '🔔 Ping des lives',     value: fmtPing(config),                      inline: false },
      {
        name: '📸 Image alertes live',
        value: config.liveAlertImageUrl ? `[Voir l'image](${config.liveAlertImageUrl})` : '`non configuree`',
        inline: false,
      },
      {
        name: '🖼️ Image de bienvenue',
        value: config.welcomeImageUrl ? `[Voir l'image](${config.welcomeImageUrl})` : '`non configuree`',
        inline: false,
      },
    )
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash_channels').setLabel('Modifier Salons').setEmoji('📌').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('dash_streams').setLabel('Configurer Twitch/TikTok').setEmoji('💜').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash_welcome_image').setLabel('Image Bienvenue').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash_refresh').setLabel('Rafraichir').setEmoji('🔄').setStyle(ButtonStyle.Success),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash_ping').setLabel('Ping des lives').setEmoji('🔔').setStyle(ButtonStyle.Danger),
  );

  return { embed, rows: [row1, row2, row3] };
}

// --- Modal : salons ---
function buildChannelsModal() {
  const config = getConfig();
  return new ModalBuilder()
    .setCustomId('channels_modal')
    .setTitle('Configurer les salons')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('alertChannelId').setLabel('ID du salon des alertes')
          .setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678')
          .setValue(config.alertChannelId || '').setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('welcomeChannelId').setLabel('ID du salon de bienvenue')
          .setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678')
          .setValue(config.welcomeChannelId || '').setRequired(false),
      ),
    );
}

async function handleChannelsModal(interaction) {
  const alertChannelId   = interaction.fields.getTextInputValue('alertChannelId').trim();
  const welcomeChannelId = interaction.fields.getTextInputValue('welcomeChannelId').trim();

  const idOk = (id) => id === '' || /^\d{17,20}$/.test(id);
  if (!idOk(alertChannelId) || !idOk(welcomeChannelId)) {
    return interaction.reply({ content: '❌ ID invalide (17 a 20 chiffres attendus).', flags: MessageFlags.Ephemeral });
  }
  setConfig({ alertChannelId, welcomeChannelId });
  return interaction.reply({ content: '✅ Salons mis a jour.', flags: MessageFlags.Ephemeral });
}

// --- Modal : streams ---
function buildStreamsModal() {
  const config = getConfig();
  return new ModalBuilder()
    .setCustomId('streams_modal')
    .setTitle('Configurer Twitch / TikTok')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('twitchUsername').setLabel("Nom d'utilisateur Twitch")
          .setStyle(TextInputStyle.Short).setPlaceholder('ex: ninja')
          .setValue(config.twitchUsername || '').setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tiktokUsername').setLabel("Nom d'utilisateur TikTok (sans @)")
          .setStyle(TextInputStyle.Short).setPlaceholder('ex: charlidamelio')
          .setValue(config.tiktokUsername || '').setRequired(false),
      ),
    );
}

async function handleStreamsModal(interaction) {
  const clean = (v) =>
    v.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(twitch\.tv|tiktok\.com)\/@?/i, '').replace(/\/.*$/, '');

  const twitchUsername = clean(interaction.fields.getTextInputValue('twitchUsername'));
  const tiktokUsername = clean(interaction.fields.getTextInputValue('tiktokUsername'));

  setConfig({ twitchUsername, tiktokUsername });
  liveState.twitch = false;
  // Reconnecte le WebSocket TikTok sur le nouveau username
  startTikTokMonitor(tiktokUsername);

  return interaction.reply({ content: '✅ Comptes Twitch/TikTok mis a jour.', flags: MessageFlags.Ephemeral });
}

// --- Modal : image de bienvenue ---
function buildWelcomeImageModal() {
  const config = getConfig();
  return new ModalBuilder()
    .setCustomId('welcome_image_modal')
    .setTitle('Image de bienvenue')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('welcomeImageUrl').setLabel("URL de l'image de fond")
          .setStyle(TextInputStyle.Paragraph).setPlaceholder('https://...')
          .setValue(config.welcomeImageUrl || '').setRequired(false),
      ),
    );
}

async function handleWelcomeImageModal(interaction) {
  const url = interaction.fields.getTextInputValue('welcomeImageUrl').trim();
  if (url !== '' && !isValidUrl(url)) {
    return interaction.reply({ content: '❌ URL invalide (doit commencer par http:// ou https://).', flags: MessageFlags.Ephemeral });
  }
  setConfig({ welcomeImageUrl: url });
  return interaction.reply({ content: '✅ Image de bienvenue mise a jour.', flags: MessageFlags.Ephemeral });
}

// --- Modal : ping des lives ---
function buildPingModal() {
  const config = getConfig();
  return new ModalBuilder()
    .setCustomId('ping_modal')
    .setTitle('Ping des alertes live')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('livePingType')
          .setLabel('Type de ping')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('everyone / here / role / aucun')
          .setValue(config.livePingType || 'everyone')
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('livePingRoleId')
          .setLabel('ID du role (uniquement si type = role)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('ex: 123456789012345678')
          .setValue(config.livePingRoleId || '')
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('liveAlertImageUrl')
          .setLabel("URL image pour les annonces live (optionnel)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://...')
          .setValue(config.liveAlertImageUrl || '')
          .setRequired(false),
      ),
    );
}

async function handlePingModal(interaction) {
  const VALID_TYPES = ['everyone', 'here', 'role', 'aucun'];
  const livePingType = interaction.fields.getTextInputValue('livePingType').trim().toLowerCase();
  const rawRoleId    = interaction.fields.getTextInputValue('livePingRoleId').trim();
  const liveAlertImageUrl = interaction.fields.getTextInputValue('liveAlertImageUrl').trim();

  // Extrait l'ID depuis une mention <@&ID> ou un ID brut
  const roleMatch   = rawRoleId.match(/^(?:<@&)?(\d{17,20})>?$/);
  const livePingRoleId = roleMatch ? roleMatch[1] : '';

  if (!VALID_TYPES.includes(livePingType)) {
    return interaction.reply({
      content: '❌ Type invalide. Choix possibles : `everyone`, `here`, `role`, `aucun`.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (livePingType === 'role' && !livePingRoleId) {
    return interaction.reply({
      content: '❌ Tu dois fournir un ID de role valide quand le type est `role`.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (liveAlertImageUrl && !isValidUrl(liveAlertImageUrl)) {
    return interaction.reply({
      content: '❌ URL image invalide (doit commencer par http:// ou https://).',
      flags: MessageFlags.Ephemeral,
    });
  }

  setConfig({ livePingType, livePingRoleId, liveAlertImageUrl });

  const preview =
    livePingType === 'everyone' ? '@everyone' :
    livePingType === 'here'     ? '@here' :
    livePingType === 'role'     ? `<@&${livePingRoleId}>` :
    'Aucun ping';

  return interaction.reply({
    content: `✅ Ping des lives mis a jour : **${preview}**`,
    flags: MessageFlags.Ephemeral,
  });
}

// ============================================================================
//  4. ALERTES LIVE — TWITCH (API officielle)
// ============================================================================
const liveState = { twitch: false, tiktok: false };

let twitchToken = { value: null, expiresAt: 0 };

async function getTwitchToken() {
  if (twitchToken.value && Date.now() < twitchToken.expiresAt) return twitchToken.value;
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_SECRET) return null;

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_SECRET,
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: 'POST' });
  if (!res.ok) { console.error('[TWITCH] Echec token :', res.status); return null; }
  const data = await res.json();
  twitchToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return twitchToken.value;
}

async function checkTwitchLive(username) {
  if (!username) return null;
  const token = await getTwitchToken();
  if (!token) return null;

  const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(username)}`, {
    headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) { console.error('[TWITCH] Erreur API :', res.status); return null; }
  const data = await res.json();
  return data.data && data.data.length > 0 ? data.data[0] : null;
}

async function getAlertChannel() {
  const { alertChannelId } = getConfig();
  if (!alertChannelId) return null;
  try { return await client.channels.fetch(alertChannelId); } catch { return null; }
}

async function checkLives() {
  const config  = getConfig();
  const channel = await getAlertChannel();
  if (!channel || !channel.isTextBased()) return;

  try {
    const stream = await checkTwitchLive(config.twitchUsername);
    if (stream && !liveState.twitch) {
      liveState.twitch = true;
      const url   = `https://twitch.tv/${config.twitchUsername}`;
      const thumb = stream.thumbnail_url
        ? stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') + `?t=${Date.now()}`
        : null;

      const embed = new EmbedBuilder()
        .setColor(0x9146ff)
        .setAuthor({ name: 'Twitch • EN DIRECT' })
        .setTitle(stream.title || `${config.twitchUsername} est en live !`)
        .setURL(url)
        .setDescription(`🔴 **${config.twitchUsername}** est en direct sur Twitch !\n\n${url}`)
        .addFields(
          { name: 'Jeu / Categorie', value: stream.game_name || 'Inconnu', inline: true },
          { name: 'Spectateurs',     value: String(stream.viewer_count ?? 0), inline: true },
        )
        .setTimestamp();
      const liveImg = config.liveAlertImageUrl && isValidUrl(config.liveAlertImageUrl)
        ? config.liveAlertImageUrl
        : thumb;
      if (liveImg) embed.setImage(liveImg);

      const ping = buildLivePing(config);
      await channel.send({ ...ping, embeds: [embed] });
    } else if (!stream && liveState.twitch) {
      liveState.twitch = false; // live termine -> rearme l'alerte
    }
  } catch (err) {
    console.error('[TWITCH] Erreur :', err.message);
  }

  // TikTok est gere en temps reel via WebSocket (startTikTokMonitor)
}

// ============================================================================
//  4b. TIKTOK LIVE — Polling HTML (pas de WebSocket ni de serveur de signature)
// ============================================================================
let tiktokPollTimer = null;

async function checkTikTokIsLive(username) {
  try {
    const res = await fetch(`https://www.tiktok.com/@${username}/live`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) return false;
    const html = await res.text();
    return /roomId":"([0-9]+)"/.test(html) || /room_id=([0-9]+)/.test(html);
  } catch {
    return false;
  }
}

function startTikTokMonitor(username) {
  if (tiktokPollTimer) { clearInterval(tiktokPollTimer); tiktokPollTimer = null; }
  liveState.tiktok = false;

  if (!username) return;
  console.log(`[TIKTOK] Debut du monitoring pour @${username} (polling toutes les ${LIVE_CHECK_INTERVAL / 60000} min)`);

  const poll = async (silent = false) => {
    if (getConfig().tiktokUsername !== username) return;
    const isLive = await checkTikTokIsLive(username);
    if (isLive && !liveState.tiktok) {
      liveState.tiktok = true;
      if (silent) {
        console.log(`[TIKTOK] @${username} deja en live au demarrage, pas d'alerte.`);
      } else {
        console.log(`[TIKTOK] @${username} est en live !`);
        await sendTikTokAlert(username).catch((e) => console.error('[TIKTOK] Erreur alerte :', e.message));
      }
    } else if (!isLive && liveState.tiktok) {
      liveState.tiktok = false;
      console.log(`[TIKTOK] @${username} a termine son live.`);
    }
  };

  poll(true); // premier check silencieux : initialise l'etat sans ping
  tiktokPollTimer = setInterval(poll, LIVE_CHECK_INTERVAL);
}

async function sendTikTokAlert(username) {
  const channel = await getAlertChannel();
  if (!channel || !channel.isTextBased()) return;

  const config = getConfig();
  const url = `https://www.tiktok.com/@${username}/live`;
  const embed = new EmbedBuilder()
    .setColor(0xff0050)
    .setAuthor({ name: 'TikTok • EN DIRECT' })
    .setTitle(`${username} est en live !`)
    .setURL(url)
    .setDescription(`🔴 **@${username}** est en direct sur TikTok !\n\n${url}`)
    .setTimestamp();

  if (config.liveAlertImageUrl && isValidUrl(config.liveAlertImageUrl)) {
    embed.setImage(config.liveAlertImageUrl);
  }

  const ping = buildLivePing(config);
  await channel.send({ ...ping, embeds: [embed] });
}

// ============================================================================
//  5. SYSTEME DE BIENVENUE
// ============================================================================
client.on(Events.GuildMemberAdd, async (member) => {
  const config = getConfig();
  if (!config.welcomeChannelId) return;

  let channel;
  try { channel = await member.guild.channels.fetch(config.welcomeChannelId); } catch { return; }
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('👋 Bienvenue !')
    .setDescription(
      `Bienvenue **${member.user.username}** sur **${member.guild.name}** !\n` +
      `Nous sommes désormais **${member.guild.memberCount}** membres. 🎉`,
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setTimestamp();

  if (config.welcomeImageUrl && isValidUrl(config.welcomeImageUrl)) {
    embed.setImage(config.welcomeImageUrl);
  }

  await channel.send({
    content: `Hé ${member.toString()}, bienvenue parmi nous ! 💜`,
    embeds: [embed],
    allowedMentions: { users: [member.id] },
  });
});

// ============================================================================
//  DEMARRAGE
// ============================================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`[OK] Connecte en tant que ${c.user.tag}`);
  console.log('[OK] Commandes disponibles : +say | +dashboard | +owner add/remove/list');

  const config = getConfig();

  // Twitch : verification immediate, puis toutes les 5 minutes
  checkLives().catch((e) => console.error(e));
  setInterval(() => checkLives().catch((e) => console.error(e)), LIVE_CHECK_INTERVAL);

  // TikTok : connexion WebSocket persistante (event-driven, pas de polling)
  startTikTokMonitor(config.tiktokUsername);
});

if (!process.env.DISCORD_TOKEN) {
  console.error('[FATAL] DISCORD_TOKEN est requis dans le fichier .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
