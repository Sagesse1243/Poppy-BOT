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
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ThumbnailBuilder,
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
    modChannelId: '',          // Salon modo ou sont envoyes les resumes
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

// Couleur principale rose
const PINK = 0xFF1493;

/** Petit embed rose standard pour toutes les reponses de commandes. */
function pe(description, title) {
  const e = new EmbedBuilder().setColor(PINK).setDescription(description);
  if (title) e.setTitle(title);
  return e;
}

// ----------------------------------------------------------------------------
//  RESUME IA (Google Gemini, gratuit) — commande +resume
// ----------------------------------------------------------------------------

// Modeles Gemini gratuits essayes en cascade (si l'un est en quota 429, on passe au suivant).
// Surchargage : GEMINI_MODEL=nom_du_modele pour forcer un seul modele.
const GEMINI_MODELS = process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
// Active uniquement si une cle est presente
const geminiReady = !!process.env.GEMINI_API_KEY;

/**
 * Recupere les `limit` derniers messages d'un salon (pagination par lots de 100).
 * Renvoie un tableau du plus ancien au plus recent.
 */
async function fetchMessages(channel, limit) {
  const collected = [];
  let before;
  while (collected.length < limit) {
    const batchSize = Math.min(100, limit - collected.length);
    const batch = await channel.messages.fetch({ limit: batchSize, before });
    if (batch.size === 0) break;
    const arr = [...batch.values()];
    collected.push(...arr);
    before = arr[arr.length - 1].id;
    if (batch.size < batchSize) break;
  }
  // Discord renvoie du plus recent au plus ancien -> on remet en ordre chronologique
  return collected.reverse();
}

/**
 * Demande a Google Gemini un resume de moderation du transcript fourni.
 * Appel REST direct (aucune dependance npm). Renvoie le texte du resume.
 */
async function summarizeMessages(transcript, onWait) {
  const systemInstruction =
    "Tu es un assistant de modération pour un serveur Discord. On te donne une " +
    "transcription de messages récents (format 'Pseudo: message'). Rédige un compte-rendu " +
    "EN FRANÇAIS destiné à l'équipe de modération, structuré EXACTEMENT avec ces sections " +
    "(garde les titres en gras et les emojis) :\n\n" +
    "**👥 Membres ayant parlé**\n" +
    "Liste les pseudos qui ont participé, du plus actif au moins actif (avec le nombre de messages si possible).\n\n" +
    "**💬 Sujets principaux**\n" +
    "Les principaux sujets de conversation, en puces.\n\n" +
    "**⚔️ Embrouilles / tensions**\n" +
    "Décris les disputes, tensions ou conflits entre membres. Précise qui est impliqué. " +
    "Si aucune embrouille, écris simplement « Aucune embrouille détectée. »\n\n" +
    "**🤬 Gros mots / insultes**\n" +
    "Liste CHAQUE message contenant une insulte, une vulgarité ou un gros mot, au format : " +
    "« Pseudo : message exact ». Recopie le message tel quel. " +
    "Si aucun gros mot, écris simplement « Aucun gros mot détecté. »\n\n" +
    "Sois factuel et exhaustif, n'invente rien, ne censure pas les gros mots dans la dernière section.";

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ parts: [{ text: transcript }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Extrait le delai conseille par Google ("retryDelay": "30s") sinon valeur par defaut
  const parseRetryDelay = (txt) => {
    const m = txt.match(/"retryDelay"\s*:\s*"(\d+)s"/);
    return m ? parseInt(m[1], 10) : 0;
  };

  let lastErr = '';
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    // Jusqu'a 2 tentatives par modele (la 2e apres le delai conseille en cas de 429)
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
        return text.trim() || 'Résumé indisponible.';
      }

      const errText = await res.text().catch(() => '');
      lastErr = `${res.status} sur ${model}`;

      // 429 = quota/minute -> on attend le delai conseille puis on retente le meme modele
      if (res.status === 429 && attempt === 0) {
        let delay = parseRetryDelay(errText);
        if (delay <= 0) delay = 30;          // defaut si Google ne precise pas
        delay = Math.min(delay, 60);          // borne a 60s
        if (onWait) await onWait(delay);      // affiche le compte a rebours cote Discord
        await sleep(delay * 1000);
        continue;                             // 2e tentative sur le meme modele
      }

      // 429 (2e echec) / 404 / 503 -> on passe au modele suivant
      if ([429, 404, 503].includes(res.status)) break;

      // Autre erreur -> on arrete
      throw new Error(`Gemini API ${res.status} : ${errText.slice(0, 200)}`);
    }
  }

  throw new Error(
    `Tous les modèles Gemini gratuits sont saturés pour le moment (dernier: ${lastErr}). ` +
    `Réessaie dans 1 minute — le quota gratuit par minute se réinitialise vite.`,
  );
}

/**
 * Découpe un long texte en morceaux <= maxLen, en coupant de préférence sur
 * les sauts de ligne (puis sur les espaces) pour ne pas casser un mot.
 */
/**
 * Découpe le texte de résumé en sections par en-tête Markdown gras (**...**).
 * Chaque section = { title, emoji, content }.
 * Si une section dépasse 4000 chars, elle est sous-découpée par blocs de lignes.
 */
function splitBySection(text) {
  const SECTION_RE = /^(\*\*[^*\n]+\*\*)/m;
  const parts = text.split(/(?=^\*\*[^*\n]+\*\*)/m).filter((p) => p.trim());
  const sections = [];

  for (const part of parts) {
    const headerMatch = part.match(SECTION_RE);
    const header  = headerMatch ? headerMatch[1] : null;
    const content = header ? part.slice(header.length).trim() : part.trim();

    // Si le contenu d'une section dépasse 4000 chars, on le sous-découpe par blocs
    const full = header ? `${header}\n${content}` : content;
    if (full.length <= 4000) {
      sections.push(full);
    } else {
      const lines = full.split('\n');
      let chunk = '';
      for (const line of lines) {
        if ((chunk + '\n' + line).length > 4000) {
          if (chunk) sections.push(chunk.trim());
          chunk = line;
        } else {
          chunk = chunk ? chunk + '\n' + line : line;
        }
      }
      if (chunk) sections.push(chunk.trim());
    }
  }

  return sections.length ? sections : [text.slice(0, 4000)];
}

/** Embed rose du panneau de publication +say (reutilise pour les mises a jour). */
function buildSayPromptEmbed(channelId, fontLabel) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setTitle("🌸✨ Publication d'un embed ✨🌸")
    .setDescription(
      `> 🎀 Configure ta publication ci-dessous, puis clique sur **📝 Ouvrir l'éditeur**.\n\n` +
      `📌 **Salon :** <#${channelId}>\n` +
      `🔤 **Police du titre :** ${fontLabel}`,
    )
    .setFooter({ text: '🌸 Poppy Bot • Éditeur d’embed' });
}

function parseHexColor(input, fallback = PINK) {
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
      return message.reply({ embeds: [pe('⛔ Cette commande est réservée aux owners.')] });
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
      embeds: [buildSayPromptEmbed(message.channelId, 'Normal')],
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

  // ---- +tools : liste toutes les commandes ----
  if (command === 'tools' || command === 'help' || command === 'commands') {
    const embed = new EmbedBuilder()
      .setColor(PINK)
      .setTitle('🌸✨ Commandes de Poppy Bot ✨🌸')
      .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
      .setDescription('> 🎀 Voici toutes les commandes disponibles. Le préfixe est **`+`**.')
      .addFields(
        {
          name: '📢🎀 Publication',
          value: `\`${PREFIX}say\` — Composer et publier un embed (salon + police au choix)`,
          inline: false,
        },
        {
          name: '⚙️💗 Configuration',
          value: `\`${PREFIX}dashboard\` — Ouvrir le panneau de configuration (alertes, streams, ping, bienvenue)`,
          inline: false,
        },
        {
          name: '👑🌺 Co-propriétaires',
          value:
            `\`${PREFIX}owner list\` — Voir les co-propriétaires\n` +
            `\`${PREFIX}owner add @membre\` — Ajouter *(super-owner)*\n` +
            `\`${PREFIX}owner remove @membre\` — Retirer *(super-owner)*`,
          inline: false,
        },
        {
          name: '🛡️🌸 Modération',
          value:
            `\`${PREFIX}resume 50\` — Résumé IA des derniers messages (10 à 1000)\n` +
            `\`${PREFIX}resume @membre\` — Résumé des messages d'une personne\n` +
            `Le résultat est envoyé dans le salon modo 🌸`,
          inline: false,
        },
        {
          name: '🛠️🩷 Utilitaire',
          value: `\`${PREFIX}tools\` — Afficher ce menu`,
          inline: false,
        },
      )
      .setFooter({ text: '🌸 Poppy Bot • Liste des commandes' })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ---- +resume [nombre] [@membre] : resume IA des derniers messages ----
  if (command === 'resume' || command === 'résumé' || command === 'summary') {
    if (!isOwnerOrCoOwner(message.guild, message.author.id)) {
      return message.reply({ embeds: [pe('⛔ Cette commande est réservée aux owners.')] });
    }
    if (!geminiReady) {
      return message.reply({ embeds: [pe('❌ Le résumé IA est désactivé : `GEMINI_API_KEY` manquante dans le `.env`.')] });
    }

    // --- Parsing des arguments : un nombre et/ou une mention de membre ---
    const MAX_SCAN = 1000;
    let targetUserId = null;
    let count = null;
    for (const arg of args) {
      const uid = parseUserId(arg);
      if (uid) { targetUserId = uid; continue; }
      const n = parseInt(arg, 10);
      if (!Number.isNaN(n)) count = n;
    }
    // Si on cible un membre : on scanne large par defaut pour attraper ses messages
    if (count === null) count = targetUserId ? 500 : 50;
    count = Math.min(Math.max(count, 10), MAX_SCAN); // borne 10..1000

    const targetMember = targetUserId
      ? await message.guild.members.fetch(targetUserId).catch(() => null)
      : null;
    const targetName = targetMember ? targetMember.user.username : null;

    const scanLabel = targetUserId
      ? `messages de **${targetName ?? 'ce membre'}** (sur les ${count} derniers)`
      : `**${count}** derniers messages`;
    const status = await message.reply({ embeds: [pe(`🧠 Lecture des ${scanLabel} et génération du résumé… 🌸`)] });

    try {
      let messages = await fetchMessages(message.channel, count);
      // Filtre : pas de bots, du texte, et (si cible) seulement la personne visee
      messages = messages.filter(
        (m) => !m.author.bot && m.content && m.content.trim().length > 0 &&
               (!targetUserId || m.author.id === targetUserId),
      );

      const transcript = messages
        .map((m) => `${m.author.username}: ${m.content.replace(/\n+/g, ' ').slice(0, 500)}`)
        .join('\n');

      if (!transcript) {
        const why = targetUserId
          ? `Aucun message texte de **${targetName ?? 'ce membre'}** dans les ${count} derniers messages.`
          : 'Aucun message texte exploitable trouvé.';
        return status.edit({ embeds: [pe(`ℹ️ ${why}`)] });
      }

      const summary = await summarizeMessages(transcript, async (delay) => {
        await status.edit({
          embeds: [pe(`⏳ Quota Gemini atteint (limite par minute). Nouvelle tentative dans **${delay}s**… 🌸`)],
        }).catch(() => {});
      });

      // Un embed par section (👥 Membres / 💬 Sujets / ⚔️ Embrouilles / 🤬 Gros mots)
      const sections = splitBySection(summary);
      const baseTitle = targetUserId ? `🛡️🌸 Résumé — ${targetName ?? 'membre'}` : '🛡️🌸 Résumé de modération';

      const embeds = sections.map((section, i) => {
        const e = new EmbedBuilder().setColor(PINK).setDescription(section);
        // Le titre de l'embed reprend le header de la section si dispo, sinon titre général
        const headerMatch = section.match(/^\*\*([^*\n]+)\*\*/);
        const sectionTitle = headerMatch ? headerMatch[1].replace(/\*\*/g, '').trim() : baseTitle;
        e.setTitle(i === 0 && !headerMatch ? baseTitle : sectionTitle);
        if (i === 0 && targetMember) e.setThumbnail(targetMember.user.displayAvatarURL({ size: 256 }));
        if (i === sections.length - 1) {
          e.addFields(
            { name: '📊 Messages analysés', value: `\`${messages.length}\``, inline: true },
            { name: '📍 Salon', value: `<#${message.channelId}>`, inline: true },
            { name: '👤 Demandé par', value: message.author.toString(), inline: true },
          ).setFooter({ text: '🌸 Poppy Bot • Résumé généré par Gemini' }).setTimestamp();
        }
        return e;
      });

      // Envoi dans le salon modo si configuré, sinon dans le salon courant
      const { modChannelId } = getConfig();
      let modChannel = null;
      if (modChannelId) {
        try { modChannel = await client.channels.fetch(modChannelId); } catch {}
      }

      const destination = (modChannel && modChannel.isTextBased()) ? modChannel : null;

      if (destination) {
        // Un message par page pour ne pas dépasser la limite globale Discord
        for (const e of embeds) await destination.send({ embeds: [e] });
        // Supprime les 2 messages (commande + statut) une fois le résumé envoyé
        await status.delete().catch(() => {});
        await message.delete().catch(() => {});
        return;
      }

      // Pas de salon modo configuré -> on poste ici (1re page édite le statut, le reste en nouveaux messages)
      await status.edit({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) await message.channel.send({ embeds: [embeds[i]] });
      return;
    } catch (err) {
      console.error('[RESUME] Erreur :', err);
      return status.edit({ embeds: [pe(`❌ Erreur lors de la génération du résumé : ${err.message ?? err}`)] });
    }
  }

  // ---- +dashboard : affiche le panneau de config ----
  if (command === 'dashboard') {
    if (!isOwnerOrCoOwner(message.guild, message.author.id)) {
      return message.reply({ embeds: [pe('⛔ Cette commande est réservée aux owners.')] });
    }
    try {
      return await message.reply(buildDashboard());
    } catch (err) {
      console.error('[DASHBOARD] Components V2 a echoue, repli sur embed :', err);
      return message.reply(buildDashboardLegacy()).catch(() => {});
    }
  }

  if (command !== 'owner') return;

  const sub = (args.shift() || '').toLowerCase();
  const guild = message.guild;

  // +owner list : createur OU co-proprietaire
  if (sub === 'list') {
    if (!isOwnerOrCoOwner(guild, message.author.id)) {
      return message.reply({ embeds: [pe("⛔ Tu n'es pas autorisé à utiliser cette commande.")] });
    }
    const owners = getOwners();
    const list = owners.length
      ? owners.map((id, i) => `\`${i + 1}.\` <@${id}> (\`${id}\`)`).join('\n')
      : '*Aucun co-proprietaire enregistre.*';

    const embed = new EmbedBuilder()
      .setColor(PINK)
      .setTitle('🌸 Co-propriétaires — Poppy Bot')
      .setDescription(
        `> **Créateur originel**\n> <@${guild.ownerId}>\n\n> **Co-propriétaires autorisés**\n${list}`,
      )
      .setFooter({ text: 'Poppy Bot  •  Gestion des accès' })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // +owner add / remove : TOI UNIQUEMENT (SUPER_OWNER_ID dans .env)
  if (sub === 'add' || sub === 'remove') {
    if (message.author.id !== process.env.SUPER_OWNER_ID) {
      return message.reply({ embeds: [pe('⛔ Seul le **super-owner** peut ajouter ou retirer un co-propriétaire.')] });
    }

    const targetId = parseUserId(args[0]);
    if (!targetId) {
      return message.reply({ embeds: [pe(`❌ Utilisation : \`${PREFIX}owner ${sub} @mention\` (ou un ID valide).`)] });
    }
    if (targetId === guild.ownerId) {
      return message.reply({ embeds: [pe('ℹ️ Le créateur originel est déjà propriétaire par défaut.')] });
    }

    const owners = getOwners();
    if (sub === 'add') {
      if (owners.includes(targetId)) return message.reply({ embeds: [pe('⚠️ Cette personne est déjà co-propriétaire.')] });
      owners.push(targetId);
      setOwners(owners);
      return message.reply({ embeds: [pe(`✅ <@${targetId}> a été **ajouté** aux co-propriétaires. 🌸`)] });
    } else {
      if (!owners.includes(targetId)) return message.reply({ embeds: [pe("⚠️ Cette personne n'est pas dans la liste des co-propriétaires.")] });
      setOwners(owners.filter((id) => id !== targetId));
      return message.reply({ embeds: [pe(`✅ <@${targetId}> a été **retiré** des co-propriétaires. 🌸`)] });
    }
  }

  return message.reply({
    embeds: [pe(
      `🎀 \`${PREFIX}owner add @mention\` — ajouter un co-propriétaire *(super-owner)*\n` +
      `🎀 \`${PREFIX}owner remove @mention\` — retirer un co-propriétaire *(super-owner)*\n` +
      `🎀 \`${PREFIX}owner list\` — afficher la liste`,
      '🌸 Commandes Owner — Poppy Bot',
    )],
  });
});

// ============================================================================
//  GESTION DES INTERACTIONS (boutons, modals)
// ============================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ---- Selecteur de salon natif (flux +say) ----
    if (interaction.isChannelSelectMenu() && interaction.customId === 'say_channel_select') {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ embeds: [pe('⛔ Action réservée aux owners.')], flags: MessageFlags.Ephemeral });
      }
      const state = sayState.get(interaction.user.id) ?? { channelId: interaction.channelId, font: 'normal' };
      state.channelId = interaction.values[0];
      sayState.set(interaction.user.id, state);

      const font = FONT_LABELS[state.font] ?? 'Normal';
      return interaction.update({
        embeds: [buildSayPromptEmbed(state.channelId ?? interaction.channelId, font)],
      });
    }

    // ---- Menu de selection de la police (flux +say) ----
    if (interaction.isStringSelectMenu() && interaction.customId === 'say_font_select') {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ embeds: [pe('⛔ Action réservée aux owners.')], flags: MessageFlags.Ephemeral });
      }
      const state = sayState.get(interaction.user.id) ?? { channelId: null, font: 'normal' };
      state.font = interaction.values[0];
      sayState.set(interaction.user.id, state);

      return interaction.update({
        embeds: [buildSayPromptEmbed(state.channelId ?? interaction.channelId, FONT_LABELS[state.font] ?? 'Normal')],
      });
    }

    if (interaction.isButton()) {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ embeds: [pe('⛔ Action réservée aux owners.')], flags: MessageFlags.Ephemeral });
      }
      switch (interaction.customId) {
        case 'say_open':           return interaction.showModal(buildSayModal());
        case 'dash_channels':      return interaction.showModal(buildChannelsModal());
        case 'dash_welcome_channel': return interaction.showModal(buildChannelsModal());
        case 'dash_streams':       return interaction.showModal(buildStreamsModal());
        case 'dash_welcome_image': return interaction.showModal(buildWelcomeImageModal());
        case 'dash_ping':          return interaction.showModal(buildPingModal());
        case 'dash_refresh': {
          try {
            return await interaction.update(buildDashboard());
          } catch (err) {
            console.error('[DASHBOARD] Refresh V2 a echoue, repli sur embed :', err);
            return interaction.update(buildDashboardLegacy()).catch(() => {});
          }
        }
      }
    }

    if (interaction.isModalSubmit()) {
      if (!isOwnerOrCoOwner(interaction.guild, interaction.user.id)) {
        return interaction.reply({ embeds: [pe('⛔ Action réservée aux owners.')], flags: MessageFlags.Ephemeral });
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
      interaction.reply({ embeds: [pe('❌ Une erreur est survenue.')], flags: MessageFlags.Ephemeral }).catch(() => {});
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
      return interaction.reply({ embeds: [pe(`❌ Salon introuvable (\`${state.channelId}\`).`)], flags: MessageFlags.Ephemeral });
    }
  }

  await targetChannel.send({ embeds: [embed] });

  // Supprime le message de selection (sélecteur de police + bouton)
  if (state.promptId) {
    try {
      const promptChannel = await client.channels.fetch(state.promptChannelId ?? interaction.channelId);
      const promptMsg = await promptChannel.messages.fetch(state.promptId);
      await promptMsg.delete();
    } catch {}
  }

  return interaction.reply({ embeds: [pe(`✅ Embed publié dans <#${targetChannel.id}>. 🌸`)], flags: MessageFlags.Ephemeral });
}

// ============================================================================
//  3. /dashboard — TABLEAU DE BORD
// ============================================================================
// Petite couleur d'accent rose pour le panneau
const DASH_ACCENT = 0xF74FB0;

/**
 * Construit le panneau de configuration avec Components V2 :
 * chaque categorie a son bouton "Configurer" aligne a droite (style screenshot).
 */
function buildDashboard() {
  const config = getConfig();
  const fmtChannel = (id) => (id ? `<#${id}>` : '`non configuré`');
  const fmtText    = (v)  => (v  ? `\`${v}\`` : '`non configuré`');

  const fmtPing = (cfg) => {
    if (cfg.livePingType === 'here')                        return '`@here`';
    if (cfg.livePingType === 'role' && cfg.livePingRoleId) return `<@&${cfg.livePingRoleId}>`;
    if (cfg.livePingType === 'aucun')                      return '`Aucun ping`';
    return '`@everyone`';
  };

  // Helper : un separateur fin
  const sep = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

  // Helper : une section "categorie" avec bouton Configurer a droite
  const section = (emoji, titre, description, customId) =>
    new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### ${emoji} ${titre}\n${description}`),
      )
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel('Configurer')
          .setEmoji('🌸')
          .setStyle(ButtonStyle.Secondary),
      );

  // En-tete avec avatar du bot a droite (comme le screenshot)
  const header = new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '# 🌸✨ Configuration de Poppy Bot ✨🌸\n' +
        '**Bienvenue dans la configuration de Poppy Bot !** 🩷\n' +
        'Sélectionne une catégorie pour configurer les fonctionnalités du bot. 💗',
      ),
    )
    .setThumbnailAccessory(
      new ThumbnailBuilder().setURL(client.user.displayAvatarURL({ size: 256 })),
    );

  const container = new ContainerBuilder()
    .setAccentColor(DASH_ACCENT)
    .addSectionComponents(header)
    .addSeparatorComponents(sep())
    .addSectionComponents(
      section('📡🎀', 'Salon des alertes',
        `Configuration du salon où les alertes live sont envoyées.\n> 🩷 **Actuel :** ${fmtChannel(config.alertChannelId)}`,
        'dash_channels'),
    )
    .addSeparatorComponents(sep())
    .addSectionComponents(
      section('🎥💗', 'Streams Twitch & TikTok',
        `Configuration des comptes à surveiller pour les lives.\n> 💜 **Twitch :** ${fmtText(config.twitchUsername)}\n> 🎵 **TikTok :** ${fmtText(config.tiktokUsername)}`,
        'dash_streams'),
    )
    .addSeparatorComponents(sep())
    .addSectionComponents(
      section('🔔🌺', 'Ping des lives',
        `Configuration du type de ping lors d'une alerte live.\n> 🌷 **Actuel :** ${fmtPing(config)}`,
        'dash_ping'),
    )
    .addSeparatorComponents(sep())
    .addSectionComponents(
      section('👋🎀', 'Salon de bienvenue & modo',
        `Salon d'accueil des nouveaux membres + salon modo des résumés.\n> 💖 **Bienvenue :** ${fmtChannel(config.welcomeChannelId)}\n> 🛡️ **Modo :** ${fmtChannel(config.modChannelId)}`,
        'dash_welcome_channel'),
    )
    .addSeparatorComponents(sep())
    .addSectionComponents(
      section('🖼️🌸', 'Image de bienvenue',
        `Configuration de l'image de fond du message de bienvenue.\n> 🦩 **Image :** ${config.welcomeImageUrl ? `[Voir l'image](${config.welcomeImageUrl})` : '`non configurée`'}`,
        'dash_welcome_image'),
    )
    .addSeparatorComponents(sep())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dash_refresh').setLabel('Rafraîchir').setEmoji('🔄').setStyle(ButtonStyle.Primary),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# 🌸 Poppy Bot • Panneau de configuration'),
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Version de repli (embed classique) si Components V2 echoue.
 * Memes customId de boutons -> fonctionnalites identiques.
 */
function buildDashboardLegacy() {
  const config = getConfig();
  const fmtChannel = (id) => (id ? `<#${id}>` : '`non configuré`');
  const fmtText    = (v)  => (v  ? `\`${v}\`` : '`non configuré`');
  const fmtPing = (cfg) => {
    if (cfg.livePingType === 'here')                        return '`@here`';
    if (cfg.livePingType === 'role' && cfg.livePingRoleId) return `<@&${cfg.livePingRoleId}>`;
    if (cfg.livePingType === 'aucun')                      return '`Aucun ping`';
    return '`@everyone`';
  };

  const embed = new EmbedBuilder()
    .setColor(PINK)
    .setTitle('🌸✨ Configuration de Poppy Bot ✨🌸')
    .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
    .setDescription('**Bienvenue dans la configuration !** 🩷\nSélectionne une catégorie ci-dessous. 💗')
    .addFields(
      { name: '📡🎀 Salon des alertes',  value: fmtChannel(config.alertChannelId), inline: true },
      { name: '🔔🌺 Ping des lives',     value: fmtPing(config),                   inline: true },
      { name: '💜 Twitch',              value: fmtText(config.twitchUsername),     inline: true },
      { name: '🎵 TikTok',              value: fmtText(config.tiktokUsername),     inline: true },
      { name: '👋🎀 Salon de bienvenue', value: fmtChannel(config.welcomeChannelId), inline: true },
      { name: '🛡️🌸 Salon modo',        value: fmtChannel(config.modChannelId),    inline: true },
      { name: '🖼️🌸 Image de fond',     value: config.welcomeImageUrl ? `[Voir](${config.welcomeImageUrl})` : '`non configurée`', inline: true },
    )
    .setFooter({ text: '🌸 Poppy Bot • Panneau de configuration' })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash_channels').setLabel('Salons').setEmoji('📡').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash_streams').setLabel('Streams').setEmoji('🎥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash_ping').setLabel('Ping').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dash_welcome_image').setLabel('Image bienvenue').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('dash_refresh').setLabel('Rafraîchir').setEmoji('🔄').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row1, row2] };
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
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('modChannelId').setLabel('ID du salon modo (résumés +resume)')
          .setStyle(TextInputStyle.Short).setPlaceholder('123456789012345678')
          .setValue(config.modChannelId || '').setRequired(false),
      ),
    );
}

async function handleChannelsModal(interaction) {
  const alertChannelId   = interaction.fields.getTextInputValue('alertChannelId').trim();
  const welcomeChannelId = interaction.fields.getTextInputValue('welcomeChannelId').trim();
  const modChannelId     = interaction.fields.getTextInputValue('modChannelId').trim();

  const idOk = (id) => id === '' || /^\d{17,20}$/.test(id);
  if (!idOk(alertChannelId) || !idOk(welcomeChannelId) || !idOk(modChannelId)) {
    return interaction.reply({ embeds: [pe('❌ ID invalide (17 à 20 chiffres attendus).')], flags: MessageFlags.Ephemeral });
  }
  setConfig({ alertChannelId, welcomeChannelId, modChannelId });
  return interaction.reply({ embeds: [pe('✅ Salons mis à jour. 🌸')], flags: MessageFlags.Ephemeral });
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

  return interaction.reply({ embeds: [pe('✅ Comptes Twitch/TikTok mis à jour. 🌸')], flags: MessageFlags.Ephemeral });
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
    return interaction.reply({ embeds: [pe('❌ URL invalide (doit commencer par http:// ou https://).')], flags: MessageFlags.Ephemeral });
  }
  setConfig({ welcomeImageUrl: url });
  return interaction.reply({ embeds: [pe('✅ Image de bienvenue mise à jour. 🌸')], flags: MessageFlags.Ephemeral });
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
      embeds: [pe('❌ Type invalide. Choix possibles : `everyone`, `here`, `role`, `aucun`.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (livePingType === 'role' && !livePingRoleId) {
    return interaction.reply({
      embeds: [pe('❌ Tu dois fournir un ID de rôle valide quand le type est `role`.')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (liveAlertImageUrl && !isValidUrl(liveAlertImageUrl)) {
    return interaction.reply({
      embeds: [pe('❌ URL image invalide (doit commencer par http:// ou https://).')],
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
    embeds: [pe(`✅ Ping des lives mis à jour : **${preview}** 🌸`)],
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
        .setColor(PINK)
        .setAuthor({ name: '🔴  Twitch — EN DIRECT' })
        .setTitle(`🌸  ${stream.title || `${config.twitchUsername} est en live !`}`)
        .setURL(url)
        .setDescription(
          `> **${config.twitchUsername}** est en direct sur Twitch !\n\n` +
          `**🎮 Jeu :** ${stream.game_name || 'Inconnu'}\n` +
          `**👥 Spectateurs :** ${stream.viewer_count ?? 0}\n\n` +
          `🔗 ${url}`,
        )
        .setFooter({ text: 'Poppy Bot  •  Alerte Live' })
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
    .setColor(PINK)
    .setAuthor({ name: '🔴  TikTok — EN DIRECT' })
    .setTitle(`🌸  @${username} est en live !`)
    .setURL(url)
    .setDescription(
      `> **@${username}** est en direct sur TikTok !\n\n` +
      `🔗 ${url}`,
    )
    .setFooter({ text: 'Poppy Bot  •  Alerte Live' })
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
    .setColor(PINK)
    .setTitle(`🌸  Bienvenue sur ${member.guild.name} !`)
    .setDescription(
      `> Hey ${member.toString()} ! On est ravis de t'accueillir parmi nous 🎀\n\n` +
      `**👤 Pseudo :** ${member.user.username}\n` +
      `**👥 Membre n°** ${member.guild.memberCount}`,
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${member.guild.name}  •  Bienvenue !` })
    .setTimestamp();

  if (config.welcomeImageUrl && isValidUrl(config.welcomeImageUrl)) {
    embed.setImage(config.welcomeImageUrl);
  }

  await channel.send({
    content: `✨ ${member.toString()}`,
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
