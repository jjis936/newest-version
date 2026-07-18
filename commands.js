// commands.js
// All slash command definitions AND their execute logic live here, plus the
// button/select-menu/modal handlers that go with them. This is intentionally
// one big file instead of a folder-per-thing - imported by both bot.js
// (to run everything) and deploy-commands.js (to register with Discord).

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    AttachmentBuilder
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// CONFIG (folded in here instead of a separate file)
// ---------------------------------------------------------------------------

const CONFIG = {
    BRAND_NAME: process.env.BRAND_NAME || "Sinner Services",
    BRAND_EMOJI: "💎",
    COLOR: "#B30000",
    VOUCH_CHANNEL_ID: process.env.VOUCH_CHANNEL_ID || "1507682259678003371",
    LEAVE_VOUCH_CHANNEL_ID: process.env.LEAVE_VOUCH_CHANNEL_ID || "1524746787636772964",
    VOUCH_PHOTO_WINDOW_MS: 5 * 60 * 1000, // 5 minutes to post proof photo

    SMS_SERVICES: [
        { label: "Telegram", value: "telegram" },
        { label: "WhatsApp", value: "whatsapp" },
        { label: "Google", value: "google" },
        { label: "Discord", value: "discord" },
        { label: "Facebook", value: "facebook" }
    ],

    SMS_COUNTRIES: [
        { label: "USA", value: "usa", slugs: { "5sim": "usa", smspool: "usa" } },
        { label: "UK", value: "uk", slugs: { "5sim": "england", smspool: "uk" } },
        { label: "Russia", value: "russia", slugs: { "5sim": "russia", smspool: "russia" } },
        { label: "Indonesia", value: "indonesia", slugs: { "5sim": "indonesia", smspool: "indonesia" } },
        { label: "Philippines", value: "philippines", slugs: { "5sim": "philippines", smspool: "philippines" } }
    ],

    BRAND_ICON_URL: process.env.BRAND_ICON_URL || null,
    WEBSITE_URL: process.env.WEBSITE_URL || "https://sinner-boost-pro.base44.app",

    TICKET_SERVICES: [
        { label: "Nuke Services", value: "nuke", emoji: "☢️" },
        { label: "WZ Ranked Boost", value: "wz_ranked", emoji: "⚔️" },
        { label: "MP Ranked Boost", value: "mp_ranked", emoji: "🔫" },
        { label: "Camos", value: "camos", emoji: "🎨" },
        { label: "Number Rental", value: "number_rental", emoji: "📱" }
    ]
};

function countrySlug(value, provider){
    const entry = CONFIG.SMS_COUNTRIES.find(c => c.value === value);
    return entry ? entry.slugs[provider] : value;
}

// Reusable "Visit Website" link button row - link buttons need no customId
// and no interaction handler, Discord just opens the URL directly.
function websiteRow(){
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel("🌐 Visit Our Website")
            .setStyle(ButtonStyle.Link)
            .setURL(CONFIG.WEBSITE_URL)
    );
}

// Shared "house style" embed builder - every command uses this so they all
// look consistent instead of each one improvising its own layout.
function brandEmbed({ title, description, fields, thumbnail, color }){
    const embed = new EmbedBuilder()
        .setColor(color || CONFIG.COLOR)
        .setTitle(title)
        .setFooter({
            text: `${CONFIG.BRAND_NAME}`,
            iconURL: CONFIG.BRAND_ICON_URL || undefined
        })
        .setTimestamp();

    if(description) embed.setDescription(description);
    if(fields && fields.length) embed.addFields(fields);
    if(thumbnail !== false && CONFIG.BRAND_ICON_URL) embed.setThumbnail(CONFIG.BRAND_ICON_URL);

    return embed;
}

// Downloads a Discord attachment (from a slash command option or a message)
// and returns a fresh AttachmentBuilder wrapping its bytes. Reused by every
// command that lets someone attach an image, so the message the bot posts
// owns an independent copy of the file instead of pointing at a CDN link
// that can expire, get revoked, or come back blurred once the original
// message/interaction is gone.
async function rehostAttachment(attachment, fallbackName = "image.png"){
    if(!attachment) return null;
    try{
        const res = await fetch(attachment.url);
        if(!res.ok){
            console.log(`[rehostAttachment] download failed with status ${res.status}`);
            return null;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: attachment.name || fallbackName });
    }catch(err){
        console.log(`[rehostAttachment] error: ${err.message}`);
        return null;
    }
}

// Quick, forgiving URL check used by /link and /url so a typo gives a clean
// error reply instead of an ugly Discord API rejection.
function isValidUrl(value){
    try{
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
    }catch{
        return false;
    }
}

// ---------------------------------------------------------------------------
// TINY JSON DATA LAYER (one folder, one helper, every feature reuses it)
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function db(name, fallback){
    const file = path.join(DATA_DIR, `${name}.json`);
    if(!fs.existsSync(file)){
        fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    }
    return {
        read: () => JSON.parse(fs.readFileSync(file, "utf8")),
        write: (data) => fs.writeFileSync(file, JSON.stringify(data, null, 2))
    };
}

const vouchesDB = db("vouches", { entries: [], totalVouches: 0, ratingSum: 0, ratingCount: 0 });
const usersDB = db("users", {});               // { [userId]: { vouches } }
const giveawaysDB = db("giveaways", {});        // { [messageId]: {...} }
const warningsDB = db("warnings", {});          // { [userId]: [reasons] }
const numbersDB = db("numbers", { orders: [], counter: 1 });
const ticketLogDB = db("tickets", { open: [] });

// In-memory only - short-lived selections while a user clicks through
// the number-rental dropdowns. No need to persist this to disk.
const smsSessions = new Map();

// Tracks users who've posted vouch text but haven't added a proof photo yet.
// userId -> { content, timestamp, textMessageId, timer }
const pendingVouchPhotos = new Map();

// ---------------------------------------------------------------------------
// PROVIDERS (5sim / SMSPool) - kept inline, not separate files
// ---------------------------------------------------------------------------

const providers = {

    async fivesimBuy(country, service){
        const res = await fetch(
            `https://5sim.net/v1/user/buy/activation/${country}/any/${service}`,
            { headers: { Authorization: `Bearer ${process.env.FIVESIM_API_KEY}` } }
        );
        const data = await res.json();
        if(!res.ok) throw new Error(data.message || "5sim purchase failed");
        return { orderId: data.id, phone: data.phone };
    },

    async fivesimCheck(orderId){
        const res = await fetch(
            `https://5sim.net/v1/user/check/${orderId}`,
            { headers: { Authorization: `Bearer ${process.env.FIVESIM_API_KEY}` } }
        );
        const data = await res.json();
        const last = Array.isArray(data.sms) && data.sms.length ? data.sms[data.sms.length - 1] : null;
        return { status: data.status, code: last ? last.code : null };
    },

    async fivesimCancel(orderId){
        const res = await fetch(
            `https://5sim.net/v1/user/cancel/${orderId}`,
            { headers: { Authorization: `Bearer ${process.env.FIVESIM_API_KEY}` } }
        );
        return res.json();
    },

    async smspoolBuy(country, service){
        const params = new URLSearchParams({ key: process.env.SMSPOOL_API_KEY, country, service });
        const res = await fetch("https://api.smspool.net/purchase/sms", { method: "POST", body: params });
        const data = await res.json();
        if(data.success !== 1) throw new Error(data.message || "SMSPool purchase failed");
        return { orderId: data.order_id, phone: data.phonenumber };
    },

    async smspoolCheck(orderId){
        const params = new URLSearchParams({ key: process.env.SMSPOOL_API_KEY, orderid: orderId });
        const res = await fetch("https://api.smspool.net/sms/check", { method: "POST", body: params });
        const data = await res.json();
        return { status: data.status, code: data.sms || null };
    },

    async smspoolResend(orderId){
        const params = new URLSearchParams({ key: process.env.SMSPOOL_API_KEY, orderid: orderId });
        const res = await fetch("https://api.smspool.net/sms/resend", { method: "POST", body: params });
        return res.json();
    },

    async smspoolCancel(orderId){
        const params = new URLSearchParams({ key: process.env.SMSPOOL_API_KEY, orderid: orderId });
        const res = await fetch("https://api.smspool.net/sms/cancel", { method: "POST", body: params });
        return res.json();
    }

};

// ---------------------------------------------------------------------------
// SLASH COMMANDS
// ---------------------------------------------------------------------------

const slashCommands = [

    // -- Vouch panel (posts the "Leave a Vouch" button) --------------------
    {
        data: new SlashCommandBuilder()
            .setName("panel")
            .setDescription("Post the Sinner Services vouch panel")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        async execute(interaction){

            const embed = brandEmbed({
                title: "⭐ Customer Reviews",
                description: `Thank you for choosing **${CONFIG.BRAND_NAME}**. We appreciate your honest feedback.`,
                fields: [
                    { name: "⭐ Rating", value: "Rate your experience from 1–5 stars.", inline: true },
                    { name: "💬 Feedback", value: "Tell us how it went.", inline: true },
                    { name: "📸 Proof", value: `Drop a screenshot in this channel within 5 minutes of submitting.`, inline: true }
                ]
            });

            const button = new ButtonBuilder()
                .setCustomId("leave_vouch")
                .setLabel("📝 Leave a Vouch")
                .setStyle(ButtonStyle.Danger);

            await interaction.reply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(button), websiteRow()]
            });

        }
    },

    // -- Ticket panel -------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("ticketpanel")
            .setDescription("Post the support/order ticket panel")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        async execute(interaction){

            const embed = brandEmbed({
                title: "Choose Your Service",
                description: `Select an option below and a private ticket will be created just for you.`,
                fields: [
                    {
                        name: "How it works",
                        value: "1️⃣ Pick a service from the dropdown\n2️⃣ A private channel opens for you\n3️⃣ Staff will claim & assist you there"
                    }
                ]
            });

            const menu = new StringSelectMenuBuilder()
                .setCustomId("ticket_select")
                .setPlaceholder("Services")
                .addOptions(CONFIG.TICKET_SERVICES.map(s => ({
                    label: s.label, value: s.value, emoji: s.emoji
                })));

            await interaction.reply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(menu), websiteRow()]
            });

        }
    },

    // -- Vouch stats ----------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("vouchstats")
            .setDescription("View vouch statistics"),

        async execute(interaction){

            const stats = vouchesDB.read();
            const ratingCount = stats.ratingCount ?? stats.totalVouches; // older data had no ratingCount field
            const avg = ratingCount
                ? (stats.ratingSum / ratingCount).toFixed(1)
                : "0.0";

            const embed = brandEmbed({
                title: `${CONFIG.BRAND_NAME} Statistics`,
                fields: [
                    { name: "📊 Total Vouches", value: `${stats.totalVouches}`, inline: true },
                    { name: "⭐ Average Rating", value: `${avg}/5`, inline: true },
                    { name: "🏆 Reputation", value: avg >= 4.5 ? "Excellent ⭐⭐⭐⭐⭐" : "Growing ⭐⭐⭐⭐", inline: true },
                    { name: "📝 Rated Vouches", value: `${ratingCount}/${stats.totalVouches}`, inline: true }
                ]
            });

            await interaction.reply({ embeds: [embed] });

        }
    },

    // -- Leaderboard ----------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("leaderboard")
            .setDescription("Top customers by vouch count"),

        async execute(interaction){

            const users = usersDB.read();

            const sorted = Object.entries(users)
                .sort((a, b) => (b[1].vouches || 0) - (a[1].vouches || 0))
                .slice(0, 10);

            const lines = sorted.length
                ? sorted.map(([id, u], i) => `**${i + 1}.** <@${id}> — ${u.vouches} vouches`).join("\n")
                : "No vouches yet.";

            const embed = brandEmbed({
                title: "🏆 Top Customers",
                description: lines
            });

            await interaction.reply({ embeds: [embed] });

        }
    },

    // -- Giveaway ---------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("giveaway")
            .setDescription("Start a giveaway")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName("prize").setDescription("What are you giving away").setRequired(true))
            .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setRequired(true)),

        async execute(interaction){

            const prize = interaction.options.getString("prize");
            const minutes = interaction.options.getInteger("minutes");
            const endTime = Date.now() + minutes * 60000;

            const embed = brandEmbed({
                title: "🎉 Giveaway",
                color: "#b026ff",
                fields: [
                    { name: "🎁 Prize", value: prize, inline: true },
                    { name: "⏰ Ends", value: `<t:${Math.floor(endTime / 1000)}:R>`, inline: true }
                ]
            });

            const enterButton = new ButtonBuilder()
                .setCustomId("giveaway_enter")
                .setLabel("🎉 Enter")
                .setStyle(ButtonStyle.Success);

            const msg = await interaction.reply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(enterButton)],
                fetchReply: true
            });

            const giveaways = giveawaysDB.read();
            giveaways[msg.id] = {
                prize, endTime, channelId: interaction.channel.id, entries: [], ended: false
            };
            giveawaysDB.write(giveaways);

        }
    },

    // -- Moderation: ban / kick / warn / timeout ---------------------------
    {
        data: new SlashCommandBuilder()
            .setName("ban")
            .setDescription("Ban a member")
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
            .addUserOption(o => o.setName("user").setDescription("User to ban").setRequired(true))
            .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const user = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason") || "No reason provided";
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if(!member){
                return interaction.reply({ content: "❌ User not found.", ephemeral: true });
            }
            await member.ban({ reason });
            await interaction.reply({ content: `🔨 Banned ${user.tag} — ${reason}` });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName("kick")
            .setDescription("Kick a member")
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
            .addUserOption(o => o.setName("user").setDescription("User to kick").setRequired(true))
            .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const user = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason") || "No reason provided";
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if(!member){
                return interaction.reply({ content: "❌ User not found.", ephemeral: true });
            }
            await member.kick(reason);
            await interaction.reply({ content: `👢 Kicked ${user.tag} — ${reason}` });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName("warn")
            .setDescription("Warn a member")
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(o => o.setName("user").setDescription("User to warn").setRequired(true))
            .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const user = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason");
            const warnings = warningsDB.read();
            warnings[user.id] = warnings[user.id] || [];
            warnings[user.id].push({ reason, at: new Date().toISOString() });
            warningsDB.write(warnings);
            await interaction.reply({ content: `⚠️ Warned ${user.tag} — ${reason} (total: ${warnings[user.id].length})` });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName("timeout")
            .setDescription("Timeout a member")
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(o => o.setName("user").setDescription("User to timeout").setRequired(true))
            .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setRequired(true))
            .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const user = interaction.options.getUser("user");
            const minutes = interaction.options.getInteger("minutes");
            const reason = interaction.options.getString("reason") || "No reason provided";
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if(!member){
                return interaction.reply({ content: "❌ User not found.", ephemeral: true });
            }
            await member.timeout(minutes * 60000, reason);
            await interaction.reply({ content: `⏳ Timed out ${user.tag} for ${minutes}m — ${reason}` });
        }
    },

    // -- SMS number rental --------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("getnumber")
            .setDescription("Rent a temporary phone number for SMS verification"),

        async execute(interaction){

            smsSessions.set(interaction.user.id, {});

            const embed = brandEmbed({
                title: "📱 Number Rental",
                description: "Pick a provider to get started."
            });

            const menu = new StringSelectMenuBuilder()
                .setCustomId("sms_provider_select")
                .setPlaceholder("Choose a provider...")
                .addOptions(
                    { label: "5sim", value: "5sim", emoji: "5️⃣" },
                    { label: "SMSPool", value: "smspool", emoji: "🌀" }
                );

            await interaction.reply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(menu), websiteRow()],
                ephemeral: true
            });

        }
    },
    {
        data: new SlashCommandBuilder()
            .setName("numberlog")
            .setDescription("Staff: view recent SMS number rental orders")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const { orders } = numbersDB.read();
            const recent = orders.slice(-10).reverse();
            const lines = recent.length
                ? recent.map(o => `**${o.id}** • <@${o.buyer}> • ${o.provider} • ${o.service}/${o.country} • ${o.status}`).join("\n")
                : "No orders yet.";
            const embed = brandEmbed({
                title: "🧾 Recent Number Orders",
                description: lines
            });
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },

    // -- Fast-path number generation (no clicking through dropdowns) -------
    {
        data: new SlashCommandBuilder()
            .setName("gen")
            .setDescription("Quickly generate a number - skips the dropdown menus")
            .addStringOption(o => o.setName("provider").setDescription("Provider").setRequired(true)
                .addChoices({ name: "5sim", value: "5sim" }, { name: "SMSPool", value: "smspool" }))
            .addStringOption(o => o.setName("service").setDescription("Service").setRequired(true)
                .addChoices(...CONFIG.SMS_SERVICES.map(s => ({ name: s.label, value: s.value }))))
            .addStringOption(o => o.setName("country").setDescription("Region").setRequired(true)
                .addChoices(...CONFIG.SMS_COUNTRIES.map(c => ({ name: c.label, value: c.value })))),

        async execute(interaction){

            const provider = interaction.options.getString("provider");
            const service = interaction.options.getString("service");
            const country = interaction.options.getString("country");

            await interaction.deferReply({ ephemeral: true });

            const slug = countrySlug(country, provider);
            let purchase;

            try{
                purchase = provider === "5sim"
                    ? await providers.fivesimBuy(slug, service)
                    : await providers.smspoolBuy(slug, service);
            }catch(err){
                return interaction.editReply({ content: `❌ Purchase failed: ${err.message}` });
            }

            const numbers = numbersDB.read();
            const orderId = "SN-" + String(numbers.counter).padStart(4, "0");
            numbers.orders.push({
                id: orderId, buyer: interaction.user.id, provider, service, country,
                phone: purchase.phone, providerOrderId: purchase.orderId,
                status: "pending", code: null, created: new Date().toISOString()
            });
            numbers.counter++;
            numbersDB.write(numbers);

            smsSessions.set(interaction.user.id, {
                provider, service, country,
                providerOrderId: purchase.orderId,
                localOrderId: orderId
            });

            const embed = brandEmbed({
                title: "✅ Number Ready",
                fields: [
                    { name: "☎️ Number", value: `${purchase.phone}`, inline: true },
                    { name: "🧾 Order", value: `${orderId}`, inline: true }
                ]
            });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("sms_check").setLabel("📩 Check SMS").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("sms_resend").setLabel("🔁 Resend/Retry").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId("sms_cancel").setLabel("🚫 Cancel & Refund").setStyle(ButtonStyle.Danger)
            );

            await interaction.editReply({ embeds: [embed], components: [row] });

        }
    },

    // -- Server info ----------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("serverinfo")
            .setDescription("View stats about this server"),

        async execute(interaction){
            const g = interaction.guild;
            const embed = brandEmbed({
                title: `📊 ${g.name}`,
                thumbnail: false,
                fields: [
                    { name: "👥 Members", value: `${g.memberCount}`, inline: true },
                    { name: "🚀 Boost Level", value: `${g.premiumTier}`, inline: true },
                    { name: "💎 Boosts", value: `${g.premiumSubscriptionCount || 0}`, inline: true },
                    { name: "📅 Created", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true },
                    { name: "😀 Emojis", value: `${g.emojis.cache.size}`, inline: true },
                    { name: "🎭 Roles", value: `${g.roles.cache.size}`, inline: true }
                ]
            });
            if(g.iconURL()) embed.setThumbnail(g.iconURL());
            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- User info --------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("userinfo")
            .setDescription("View info about a member")
            .addUserOption(o => o.setName("user").setDescription("Who to look up").setRequired(false)),

        async execute(interaction){
            const user = interaction.options.getUser("user") || interaction.user;
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);

            const embed = brandEmbed({
                title: `👤 ${user.tag}`,
                thumbnail: false,
                fields: [
                    { name: "🆔 ID", value: user.id, inline: true },
                    { name: "📅 Account Created", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`, inline: true },
                    { name: "📥 Joined Server", value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : "Unknown", inline: true },
                    { name: "🎭 Roles", value: member ? `${member.roles.cache.size - 1}` : "Unknown", inline: true }
                ]
            });
            embed.setThumbnail(user.displayAvatarURL());

            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- Avatar -------------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("avatar")
            .setDescription("Get a member's avatar")
            .addUserOption(o => o.setName("user").setDescription("Whose avatar").setRequired(false)),

        async execute(interaction){
            const user = interaction.options.getUser("user") || interaction.user;
            const embed = brandEmbed({
                title: `🖼️ ${user.tag}'s Avatar`,
                thumbnail: false
            });
            embed.setImage(user.displayAvatarURL({ size: 512 }));
            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- Suggestions ----------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("suggest")
            .setDescription("Submit a suggestion for the server")
            .addStringOption(o => o.setName("idea").setDescription("Your suggestion").setRequired(true)),

        async execute(interaction){
            const idea = interaction.options.getString("idea");

            const embed = brandEmbed({
                title: "💡 New Suggestion",
                description: idea,
                thumbnail: false
            }).setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
            await msg.react("👍").catch(() => {});
            await msg.react("👎").catch(() => {});
        }
    },

    // -- Ticket stats (staff) -----------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("ticketstats")
            .setDescription("Staff: view ticket activity")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const log = ticketLogDB.read();
            const stillOpen = log.open.filter(t =>
                interaction.guild.channels.cache.has(t.channelId)
            );

            const byService = {};
            for(const t of log.open){
                byService[t.service] = (byService[t.service] || 0) + 1;
            }

            const breakdown = Object.entries(byService)
                .map(([service, count]) => `**${service}:** ${count}`)
                .join("\n") || "No tickets yet.";

            const embed = brandEmbed({
                title: "🎫 Ticket Stats",
                fields: [
                    { name: "📬 Currently Open", value: `${stillOpen.length}`, inline: true },
                    { name: "📈 All-Time Total", value: `${log.open.length}`, inline: true },
                    { name: "By Service", value: breakdown }
                ]
            });

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },

    // -- Ping / latency check ------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("ping")
            .setDescription("Check if the bot is alive and how fast it's responding"),

        async execute(interaction){
            const sent = await interaction.reply({ content: "🏓 Pinging...", withResponse: true });
            const roundtrip = sent.resource?.message
                ? sent.resource.message.createdTimestamp - interaction.createdTimestamp
                : 0;
            await interaction.editReply(
                `🏓 Pong! Roundtrip: ${roundtrip}ms | WebSocket: ${interaction.client.ws.ping}ms`
            );
        }
    },

    // -- Auto-generated help/command list -------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("help")
            .setDescription("List everything this bot can do"),

        async execute(interaction){
            // Built from the same slashCommands array used to register commands,
            // so this can never drift out of sync with what's actually available.
            const lines = slashCommands
                .filter(c => c.data.name !== "help")
                .map(c => `**/${c.data.name}** — ${c.data.description}`)
                .join("\n");

            const embed = brandEmbed({
                title: `${CONFIG.BRAND_NAME} — Commands`,
                description: lines
            });

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },

    // -- Self-diagnostic status command (the "surprise") --------------------
    {
        data: new SlashCommandBuilder()
            .setName("status")
            .setDescription("Staff: check the bot's own health & config")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        async execute(interaction){

            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const checks = [];

            checks.push([`TOKEN`, !!process.env.TOKEN]);
            checks.push([`CLIENT_ID`, !!process.env.CLIENT_ID]);
            checks.push([`VOUCH_CHANNEL_ID`, !!CONFIG.VOUCH_CHANNEL_ID]);
            checks.push([`LEAVE_VOUCH_CHANNEL_ID`, !!CONFIG.LEAVE_VOUCH_CHANNEL_ID]);
            checks.push([`FIVESIM_API_KEY`, !!process.env.FIVESIM_API_KEY]);
            checks.push([`SMSPOOL_API_KEY`, !!process.env.SMSPOOL_API_KEY]);

            let vouchChannelOk = "N/A";
            if(CONFIG.VOUCH_CHANNEL_ID){
                const ch = await interaction.guild.channels.fetch(CONFIG.VOUCH_CHANNEL_ID).catch(() => null);
                vouchChannelOk = ch ? `✅ found (#${ch.name})` : "❌ not found in this server - check the ID and bot permissions";
            }

            let leaveVouchChannelOk = "N/A";
            if(CONFIG.LEAVE_VOUCH_CHANNEL_ID){
                const ch = await interaction.guild.channels.fetch(CONFIG.LEAVE_VOUCH_CHANNEL_ID).catch(() => null);
                leaveVouchChannelOk = ch ? `✅ found (#${ch.name})` : "❌ not found in this server - check the ID and bot permissions";
            }

            const lines = checks.map(([name, ok]) => `${ok ? "✅" : "❌"} ${name}`).join("\n");

            const embed = brandEmbed({
                title: "🩺 Bot Status",
                fields: [
                    { name: "Environment", value: lines },
                    { name: "📢 Vouch channel", value: vouchChannelOk },
                    { name: "📝 Leave-vouch channel", value: leaveVouchChannelOk }
                ],
                description: "If anything above is ❌, that's almost certainly why a feature is failing."
            });

            await interaction.reply({ embeds: [embed], ephemeral: true });

        }
    },

    // -- Post: send any message (plain or embedded) as the bot --------------
    {
        data: new SlashCommandBuilder()
            .setName("post")
            .setDescription("Staff: send a message to any channel as the bot")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName("message").setDescription("What to say").setRequired(true).setMaxLength(2000))
            .addChannelOption(o => o.setName("channel").setDescription("Channel to post in (default: here)").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addBooleanOption(o => o.setName("embed").setDescription("Wrap it in a branded embed instead of plain text").setRequired(false))
            .addAttachmentOption(o => o.setName("image").setDescription("Optional image to attach").setRequired(false)),

        async execute(interaction){

            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const text = interaction.options.getString("message");
            const channel = interaction.options.getChannel("channel") || interaction.channel;
            const useEmbed = interaction.options.getBoolean("embed") ?? false;
            const imageAttachment = interaction.options.getAttachment("image");

            if(!channel.isTextBased()){
                return interaction.reply({ content: "❌ That's not a text channel.", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const rehosted = await rehostAttachment(imageAttachment);
            const files = rehosted ? [rehosted] : [];

            const payload = useEmbed
                ? { embeds: [(() => {
                        const e = brandEmbed({ description: text });
                        if(rehosted) e.setImage(`attachment://${rehosted.name}`);
                        return e;
                    })()], files }
                : { content: text, files };

            const sent = await channel.send(payload).catch(err => {
                console.log(`[post] ❌ failed to send: ${err.message}`);
                return null;
            });

            if(!sent){
                return interaction.editReply({ content: `❌ Couldn't post in ${channel} — check my permissions there.` });
            }

            await interaction.editReply({ content: `✅ Posted in ${channel}. [Jump to message](${sent.url})` });

        }
    },

    // -- Announcement: title + body, optional ping, optional banner ---------
    {
        data: new SlashCommandBuilder()
            .setName("announcement")
            .setDescription("Staff: post a formatted announcement")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName("title").setDescription("Announcement title").setRequired(true).setMaxLength(256))
            .addStringOption(o => o.setName("message").setDescription("Announcement body").setRequired(true).setMaxLength(4000))
            .addChannelOption(o => o.setName("channel").setDescription("Channel to post in (default: here)").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addStringOption(o => o.setName("ping").setDescription("Who to notify").setRequired(false)
                .addChoices(
                    { name: "Nobody", value: "none" },
                    { name: "@everyone", value: "everyone" },
                    { name: "@here", value: "here" },
                    { name: "Specific role", value: "role" }
                ))
            .addRoleOption(o => o.setName("role").setDescription("Role to ping (used when ping = Specific role)").setRequired(false))
            .addAttachmentOption(o => o.setName("image").setDescription("Banner image").setRequired(false))
            .addStringOption(o => o.setName("color").setDescription("Hex color override, e.g. #ff0000").setRequired(false)),

        async execute(interaction){

            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const title = interaction.options.getString("title");
            const message = interaction.options.getString("message");
            const channel = interaction.options.getChannel("channel") || interaction.channel;
            const ping = interaction.options.getString("ping") || "none";
            const role = interaction.options.getRole("role");
            const imageAttachment = interaction.options.getAttachment("image");
            const color = interaction.options.getString("color");

            if(!channel.isTextBased()){
                return interaction.reply({ content: "❌ That's not a text channel.", ephemeral: true });
            }
            if(ping === "role" && !role){
                return interaction.reply({ content: "❌ Pick a role with the `role` option when `ping` is set to Specific role.", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const rehosted = await rehostAttachment(imageAttachment, "announcement.png");

            const embed = brandEmbed({
                title: `📢 ${title}`,
                description: message,
                color: color || undefined
            }).setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            if(rehosted) embed.setImage(`attachment://${rehosted.name}`);

            let content;
            let allowedMentions = { parse: [] };
            if(ping === "everyone"){ content = "@everyone"; allowedMentions = { parse: ["everyone"] }; }
            else if(ping === "here"){ content = "@here"; allowedMentions = { parse: ["everyone"] }; }
            else if(ping === "role"){ content = `<@&${role.id}>`; allowedMentions = { roles: [role.id] }; }

            const sent = await channel.send({
                content,
                embeds: [embed],
                files: rehosted ? [rehosted] : [],
                allowedMentions
            }).catch(err => {
                console.log(`[announcement] ❌ failed to send: ${err.message}`);
                return null;
            });

            if(!sent){
                return interaction.editReply({ content: `❌ Couldn't post in ${channel} — check my permissions there.` });
            }

            await interaction.editReply({ content: `✅ Announcement posted in ${channel}. [Jump to message](${sent.url})` });

        }
    },

    // -- Link: branded link-button card --------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("link")
            .setDescription("Staff: post a branded link button card")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName("label").setDescription("Button label").setRequired(true).setMaxLength(80))
            .addStringOption(o => o.setName("url").setDescription("Where the button should go").setRequired(true))
            .addStringOption(o => o.setName("title").setDescription("Embed title").setRequired(false).setMaxLength(256))
            .addStringOption(o => o.setName("description").setDescription("Embed body text").setRequired(false).setMaxLength(2000))
            .addChannelOption(o => o.setName("channel").setDescription("Channel to post in (default: here)").addChannelTypes(ChannelType.GuildText).setRequired(false)),

        async execute(interaction){

            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const label = interaction.options.getString("label");
            const url = interaction.options.getString("url");
            const title = interaction.options.getString("title") || "🔗 Quick Link";
            const description = interaction.options.getString("description");
            const channel = interaction.options.getChannel("channel") || interaction.channel;

            if(!isValidUrl(url)){
                return interaction.reply({ content: "❌ That doesn't look like a valid `http(s)://` URL.", ephemeral: true });
            }
            if(!channel.isTextBased()){
                return interaction.reply({ content: "❌ That's not a text channel.", ephemeral: true });
            }

            const embed = brandEmbed({ title, description });

            const button = new ButtonBuilder()
                .setLabel(label)
                .setStyle(ButtonStyle.Link)
                .setURL(url);

            const sent = await channel.send({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(button)]
            }).catch(err => {
                console.log(`[link] ❌ failed to send: ${err.message}`);
                return null;
            });

            if(!sent){
                return interaction.reply({ content: `❌ Couldn't post in ${channel} — check my permissions there.`, ephemeral: true });
            }

            await interaction.reply({ content: `✅ Posted in ${channel}.`, ephemeral: true });

        }
    },

    // -- URL: quick clean link card, open to everyone ------------------------
    {
        data: new SlashCommandBuilder()
            .setName("url")
            .setDescription("Share a link as a clean embed card")
            .addStringOption(o => o.setName("link").setDescription("The URL to share").setRequired(true))
            .addStringOption(o => o.setName("note").setDescription("Optional note to go with it").setRequired(false).setMaxLength(500)),

        async execute(interaction){

            const link = interaction.options.getString("link");
            const note = interaction.options.getString("note");

            if(!isValidUrl(link)){
                return interaction.reply({ content: "❌ That doesn't look like a valid `http(s)://` URL.", ephemeral: true });
            }

            let hostname = link;
            try{ hostname = new URL(link).hostname.replace(/^www\./, ""); }catch{}

            const embed = brandEmbed({
                title: `🔗 ${hostname}`,
                description: note || undefined,
                thumbnail: false
            }).setURL(link).setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            await interaction.reply({ embeds: [embed] });

        }
    },

    // -- Embed: full custom embed builder, JSON override for power users ----
    {
        data: new SlashCommandBuilder()
            .setName("embed")
            .setDescription("Staff: build and post a fully custom embed")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName("title").setDescription("Embed title").setRequired(false).setMaxLength(256))
            .addStringOption(o => o.setName("description").setDescription("Embed body text").setRequired(false).setMaxLength(4000))
            .addStringOption(o => o.setName("color").setDescription("Hex color, e.g. #ff0000").setRequired(false))
            .addStringOption(o => o.setName("url").setDescription("URL the title links to").setRequired(false))
            .addStringOption(o => o.setName("thumbnail").setDescription("Thumbnail image URL").setRequired(false))
            .addStringOption(o => o.setName("author").setDescription("Author name shown above the title").setRequired(false))
            .addStringOption(o => o.setName("footer").setDescription("Footer text (overrides default)").setRequired(false))
            .addAttachmentOption(o => o.setName("image").setDescription("Big image to display in the embed").setRequired(false))
            .addChannelOption(o => o.setName("channel").setDescription("Channel to post in (default: here)").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addStringOption(o => o.setName("json").setDescription("Advanced: raw embed JSON, overrides every other option").setRequired(false)),

        async execute(interaction){

            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const title = interaction.options.getString("title");
            const description = interaction.options.getString("description");
            const color = interaction.options.getString("color");
            const url = interaction.options.getString("url");
            const thumbnail = interaction.options.getString("thumbnail");
            const author = interaction.options.getString("author");
            const footer = interaction.options.getString("footer");
            const imageAttachment = interaction.options.getAttachment("image");
            const channel = interaction.options.getChannel("channel") || interaction.channel;
            const json = interaction.options.getString("json");

            if(!channel.isTextBased()){
                return interaction.reply({ content: "❌ That's not a text channel.", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const rehosted = await rehostAttachment(imageAttachment, "embed-image.png");
            const files = rehosted ? [rehosted] : [];

            let embed;

            if(json){
                let parsed;
                try{
                    parsed = JSON.parse(json);
                }catch(err){
                    return interaction.editReply({ content: `❌ Invalid JSON: ${err.message}` });
                }
                try{
                    embed = new EmbedBuilder(parsed);
                }catch(err){
                    return interaction.editReply({ content: `❌ Discord rejected that embed JSON: ${err.message}` });
                }
                if(rehosted) embed.setImage(`attachment://${rehosted.name}`);
            }else{
                if(!title && !description && !imageAttachment && !thumbnail){
                    return interaction.editReply({ content: "❌ Give me at least a title, description, image, or thumbnail to build an embed with." });
                }
                embed = new EmbedBuilder().setColor(color || CONFIG.COLOR);
                if(title) embed.setTitle(title);
                if(description) embed.setDescription(description);
                if(url){
                    if(!isValidUrl(url)) return interaction.editReply({ content: "❌ The `url` option isn't a valid `http(s)://` link." });
                    embed.setURL(url);
                }
                if(thumbnail) embed.setThumbnail(thumbnail);
                if(author) embed.setAuthor({ name: author });
                embed.setFooter({ text: footer || CONFIG.BRAND_NAME, iconURL: CONFIG.BRAND_ICON_URL || undefined });
                embed.setTimestamp();
                if(rehosted) embed.setImage(`attachment://${rehosted.name}`);
            }

            const sent = await channel.send({ embeds: [embed], files }).catch(err => {
                console.log(`[embed] ❌ failed to send: ${err.message}`);
                return null;
            });

            if(!sent){
                return interaction.editReply({ content: `❌ Couldn't post in ${channel} — check my permissions there, and that the embed is valid.` });
            }

            await interaction.editReply({ content: `✅ Embed posted in ${channel}. [Jump to message](${sent.url})\n\`message_id: ${sent.id}\`` });

        }
    },

    // -- Edit an embed the bot already posted --------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("editembed")
            .setDescription("Staff: edit an embed the bot previously posted")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(o => o.setName("message_id").setDescription("ID of the bot's message to edit").setRequired(true))
            .addChannelOption(o => o.setName("channel").setDescription("Channel the message is in (default: here)").addChannelTypes(ChannelType.GuildText).setRequired(false))
            .addStringOption(o => o.setName("title").setDescription("New title").setRequired(false).setMaxLength(256))
            .addStringOption(o => o.setName("description").setDescription("New body text").setRequired(false).setMaxLength(4000))
            .addStringOption(o => o.setName("color").setDescription("New hex color").setRequired(false))
            .addAttachmentOption(o => o.setName("image").setDescription("New image").setRequired(false)),

        async execute(interaction){

            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const messageId = interaction.options.getString("message_id");
            const channel = interaction.options.getChannel("channel") || interaction.channel;
            const title = interaction.options.getString("title");
            const description = interaction.options.getString("description");
            const color = interaction.options.getString("color");
            const imageAttachment = interaction.options.getAttachment("image");

            if(!channel.isTextBased()){
                return interaction.reply({ content: "❌ That's not a text channel.", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const target = await channel.messages.fetch(messageId).catch(() => null);
            if(!target){
                return interaction.editReply({ content: "❌ Couldn't find that message in that channel." });
            }
            if(target.author.id !== interaction.client.user.id){
                return interaction.editReply({ content: "❌ That message wasn't posted by me — I can only edit my own embeds." });
            }
            if(!target.embeds.length){
                return interaction.editReply({ content: "❌ That message doesn't have an embed to edit." });
            }

            const embed = EmbedBuilder.from(target.embeds[0]);
            if(title) embed.setTitle(title);
            if(description) embed.setDescription(description);
            if(color) embed.setColor(color);

            const rehosted = await rehostAttachment(imageAttachment, "embed-image.png");
            const files = rehosted ? [rehosted] : undefined;
            if(rehosted) embed.setImage(`attachment://${rehosted.name}`);

            await target.edit({ embeds: [embed], files }).catch(err => {
                return interaction.editReply({ content: `❌ Couldn't edit that message: ${err.message}` });
            });

            await interaction.editReply({ content: `✅ Updated. [Jump to message](${target.url})` });

        }
    },

    // -- Poll: quick reaction poll, up to 4 options --------------------------
    {
        data: new SlashCommandBuilder()
            .setName("poll")
            .setDescription("Start a quick reaction poll")
            .addStringOption(o => o.setName("question").setDescription("The poll question").setRequired(true).setMaxLength(256))
            .addStringOption(o => o.setName("option1").setDescription("First option").setRequired(true).setMaxLength(100))
            .addStringOption(o => o.setName("option2").setDescription("Second option").setRequired(true).setMaxLength(100))
            .addStringOption(o => o.setName("option3").setDescription("Third option").setRequired(false).setMaxLength(100))
            .addStringOption(o => o.setName("option4").setDescription("Fourth option").setRequired(false).setMaxLength(100)),

        async execute(interaction){

            const question = interaction.options.getString("question");
            const emojis = ["🇦", "🇧", "🇨", "🇩"];
            const options = ["option1", "option2", "option3", "option4"]
                .map(name => interaction.options.getString(name))
                .filter(Boolean);

            const lines = options.map((opt, i) => `${emojis[i]} ${opt}`).join("\n");

            const embed = brandEmbed({
                title: "📊 " + question,
                description: lines,
                thumbnail: false
            }).setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            const sent = await interaction.reply({ embeds: [embed], fetchReply: true });
            for(let i = 0; i < options.length; i++){
                await sent.react(emojis[i]).catch(() => {});
            }

        }
    },

    // -- Personal reminder ---------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("remind")
            .setDescription("Get a DM reminder after a set amount of time")
            .addStringOption(o => o.setName("message").setDescription("What to be reminded about").setRequired(true).setMaxLength(200))
            .addIntegerOption(o => o.setName("minutes").setDescription("Remind me in how many minutes").setRequired(true).setMinValue(1).setMaxValue(10080)),

        async execute(interaction){

            const message = interaction.options.getString("message");
            const minutes = interaction.options.getInteger("minutes");
            const fireAt = Date.now() + minutes * 60000;

            await interaction.reply({
                content: `⏰ Got it — I'll remind you <t:${Math.floor(fireAt / 1000)}:R>.`,
                ephemeral: true
            });

            setTimeout(async () => {
                const embed = brandEmbed({
                    title: "⏰ Reminder",
                    description: message,
                    thumbnail: false
                });
                const dmSucceeded = await interaction.user.send({ embeds: [embed] }).catch(() => null);
                if(!dmSucceeded){
                    // DMs closed - fall back to a ping in the channel the reminder was set from
                    await interaction.channel.send({
                        content: `${interaction.user} ⏰ Reminder: ${message}`
                    }).catch(() => {});
                }
            }, minutes * 60000);

            // Note: reminders live in memory only - a bot restart before the
            // timer fires will lose it, same tradeoff as the SMS session cache.

        }
    },

    // -- Fun: dice roll -------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("roll")
            .setDescription("Roll some dice")
            .addIntegerOption(o => o.setName("sides").setDescription("Sides per die (default 6)").setRequired(false).setMinValue(2).setMaxValue(1000))
            .addIntegerOption(o => o.setName("count").setDescription("How many dice (default 1)").setRequired(false).setMinValue(1).setMaxValue(20)),

        async execute(interaction){
            const sides = interaction.options.getInteger("sides") || 6;
            const count = interaction.options.getInteger("count") || 1;

            const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
            const total = rolls.reduce((a, b) => a + b, 0);

            const embed = brandEmbed({
                title: "🎲 Dice Roll",
                fields: [
                    { name: `${count}d${sides}`, value: rolls.join(", "), inline: true },
                    { name: "Total", value: `${total}`, inline: true }
                ],
                thumbnail: false
            });

            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- Fun: coinflip --------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("coinflip")
            .setDescription("Flip a coin"),

        async execute(interaction){
            const result = Math.random() < 0.5 ? "Heads" : "Tails";
            await interaction.reply({ content: `🪙 **${result}**!` });
        }
    },

    // -- Invite / promo card --------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("invite")
            .setDescription("Get the link to our website & services"),

        async execute(interaction){
            const embed = brandEmbed({
                title: `${CONFIG.BRAND_EMOJI} ${CONFIG.BRAND_NAME}`,
                description: `Check out everything we offer, or open a ticket to get started.`
            });
            await interaction.reply({ embeds: [embed], components: [websiteRow()] });
        }
    },

    // -- Uptime -----------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("uptime")
            .setDescription("See how long the bot has been running"),

        async execute(interaction){
            const totalSeconds = Math.floor(process.uptime());
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            const parts = [];
            if(days) parts.push(`${days}d`);
            if(hours) parts.push(`${hours}h`);
            if(minutes) parts.push(`${minutes}m`);
            parts.push(`${seconds}s`);

            const embed = brandEmbed({
                title: "🕒 Uptime",
                description: `I've been running for **${parts.join(" ")}**.`,
                thumbnail: false
            });

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

];

// ---------------------------------------------------------------------------
// BUTTON HANDLERS (customId -> function)
// ---------------------------------------------------------------------------

const buttonHandlers = {

    async leave_vouch(interaction){
        const modal = new ModalBuilder()
            .setCustomId("vouch_form")
            .setTitle("Leave a Vouch");

        const ratingInput = new TextInputBuilder()
            .setCustomId("rating")
            .setLabel("Rating (1-5)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const commentInput = new TextInputBuilder()
            .setCustomId("comment")
            .setLabel("Comment")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(ratingInput),
            new ActionRowBuilder().addComponents(commentInput)
        );

        await interaction.showModal(modal);
    },

    async giveaway_enter(interaction){
        const giveaways = giveawaysDB.read();
        const g = giveaways[interaction.message.id];

        if(!g || g.ended){
            return interaction.reply({ content: "❌ This giveaway has ended.", ephemeral: true });
        }
        if(g.entries.includes(interaction.user.id)){
            return interaction.reply({ content: "✅ You're already entered.", ephemeral: true });
        }
        g.entries.push(interaction.user.id);
        giveawaysDB.write(giveaways);
        await interaction.reply({ content: "🎉 You're entered!", ephemeral: true });
    },

    async claim_ticket(interaction){
        await interaction.channel.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true, SendMessages: true
        });
        await interaction.reply({ content: `🙋 Claimed by ${interaction.user}` });
    },

    async close_ticket(interaction){
        await interaction.reply({ content: "🔒 Closing ticket in 5 seconds..." });
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    },

    // -- SMS buttons ----------------------------------------------------------
    async sms_buy(interaction){

        const session = smsSessions.get(interaction.user.id);
        if(!session || !session.provider || !session.service || !session.country){
            return interaction.reply({ content: "❌ Session expired, run `/getnumber` again.", ephemeral: true });
        }

        await interaction.deferUpdate();

        const slug = countrySlug(session.country, session.provider);
        let purchase;

        try{
            purchase = session.provider === "5sim"
                ? await providers.fivesimBuy(slug, session.service)
                : await providers.smspoolBuy(slug, session.service);
        }catch(err){
            return interaction.editReply({ content: `❌ Purchase failed: ${err.message}`, embeds: [], components: [] });
        }

        const numbers = numbersDB.read();
        const orderId = "SN-" + String(numbers.counter).padStart(4, "0");
        numbers.orders.push({
            id: orderId,
            buyer: interaction.user.id,
            provider: session.provider,
            service: session.service,
            country: session.country,
            phone: purchase.phone,
            providerOrderId: purchase.orderId,
            status: "pending",
            code: null,
            created: new Date().toISOString()
        });
        numbers.counter++;
        numbersDB.write(numbers);

        session.providerOrderId = purchase.orderId;
        session.localOrderId = orderId;
        smsSessions.set(interaction.user.id, session);

        const embed = brandEmbed({
            title: "✅ Number Ready",
            fields: [
                { name: "☎️ Number", value: `${purchase.phone}`, inline: true },
                { name: "🧾 Order", value: `${orderId}`, inline: true }
            ]
        });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("sms_check").setLabel("📩 Check SMS").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("sms_resend").setLabel("🔁 Resend/Retry").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("sms_cancel").setLabel("🚫 Cancel & Refund").setStyle(ButtonStyle.Danger)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
    },

    async sms_check(interaction){
        const session = smsSessions.get(interaction.user.id);
        if(!session || !session.providerOrderId){
            return interaction.reply({ content: "❌ No active order.", ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        const result = session.provider === "5sim"
            ? await providers.fivesimCheck(session.providerOrderId)
            : await providers.smspoolCheck(session.providerOrderId);

        if(session.localOrderId){
            const numbers = numbersDB.read();
            const order = numbers.orders.find(o => o.id === session.localOrderId);
            if(order){
                order.status = result.code ? "received" : order.status;
                order.code = result.code || order.code;
                numbersDB.write(numbers);
            }
        }

        await interaction.editReply({
            content: result.code
                ? `📩 Code: \`${result.code}\` (status: ${result.status})`
                : `⏳ No code yet (status: ${result.status})`
        });
    },

    async sms_resend(interaction){
        const session = smsSessions.get(interaction.user.id);
        if(!session || !session.providerOrderId){
            return interaction.reply({ content: "❌ No active order.", ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        if(session.provider === "smspool"){
            await providers.smspoolResend(session.providerOrderId);
            await interaction.editReply({ content: "🔁 Requested a fresh code from SMSPool." });
        }else{
            await interaction.editReply({
                content: "ℹ️ 5sim has no resend endpoint — trigger a new SMS from the target site using the same number, then Check SMS again."
            });
        }
    },

    async sms_cancel(interaction){
        const session = smsSessions.get(interaction.user.id);
        if(!session || !session.providerOrderId){
            return interaction.reply({ content: "❌ No active order.", ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });

        if(session.provider === "5sim"){
            await providers.fivesimCancel(session.providerOrderId);
        }else{
            await providers.smspoolCancel(session.providerOrderId);
        }

        if(session.localOrderId){
            const numbers = numbersDB.read();
            const order = numbers.orders.find(o => o.id === session.localOrderId);
            if(order) order.status = "canceled";
            numbersDB.write(numbers);
        }

        smsSessions.delete(interaction.user.id);
        await interaction.editReply({ content: "🚫 Cancel/refund requested." });
    }

};

// ---------------------------------------------------------------------------
// SELECT MENU HANDLERS
// ---------------------------------------------------------------------------

const selectHandlers = {

    async ticket_select(interaction){

        const choice = interaction.values[0];
        const service = CONFIG.TICKET_SERVICES.find(s => s.value === choice);

        const existing = interaction.guild.channels.cache.find(
            c => c.name === `ticket-${interaction.user.username}`.toLowerCase()
        );
        if(existing){
            return interaction.reply({ content: "❌ You already have an open ticket.", ephemeral: true });
        }

        let channel;
        try{
            channel = await interaction.guild.channels.create({
                name: `ticket-${interaction.user.username}`.toLowerCase(),
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    // Explicitly grant the bot itself access - without this, if the
                    // bot's role doesn't have server-wide Send Messages, it can
                    // create the channel but then silently fail to post in it.
                    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ReadMessageHistory] }
                ]
            });
        }catch(err){
            console.log(`[ticket] ❌ could not create ticket channel: ${err.message}`);
            return interaction.reply({
                content: `❌ Couldn't create your ticket (\`${err.message}\`). This almost always means the bot's role is missing **Manage Channels** / **Manage Roles**, or its role sits below a role it's trying to set permissions for. Ask a staff member to check the bot's role permissions.`,
                ephemeral: true
            });
        }

        const embed = brandEmbed({
            title: "🎫 Order Setup",
            fields: [
                { name: "👤 Customer", value: `${interaction.user}`, inline: true },
                { name: "🎯 Service", value: `${service.emoji} ${service.label}`, inline: true }
            ],
            description: "A staff member will help finalize your order shortly."
        });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("claim_ticket").setLabel("🙋 Claim").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("close_ticket").setLabel("🔒 Close").setStyle(ButtonStyle.Danger)
        );

        try{
            await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });
        }catch(err){
            console.log(`[ticket] ❌ channel created but could not send embed: ${err.message}`);
            return interaction.reply({
                content: `⚠️ Ticket channel ${channel} was created, but I couldn't post in it (\`${err.message}\`). Check that the bot's role has **Send Messages** and **Embed Links** permissions.`,
                ephemeral: true
            });
        }

        const log = ticketLogDB.read();
        log.open.push({ channelId: channel.id, user: interaction.user.id, service: choice, created: new Date().toISOString() });
        ticketLogDB.write(log);

        // If they picked Number Rental, connect straight into the SMS flow
        // inside this ticket instead of making them run /getnumber separately.
        if(choice === "number_rental"){

            smsSessions.set(interaction.user.id, {});

            const smsEmbed = brandEmbed({
                title: "📱 Number Rental",
                description: "Pick a provider to get started - staff can help if you get stuck."
            });

            const smsMenu = new StringSelectMenuBuilder()
                .setCustomId("sms_provider_select")
                .setPlaceholder("Choose a provider...")
                .addOptions(
                    { label: "5sim", value: "5sim", emoji: "5️⃣" },
                    { label: "SMSPool", value: "smspool", emoji: "🌀" }
                );

            await channel.send({
                embeds: [smsEmbed],
                components: [new ActionRowBuilder().addComponents(smsMenu)]
            }).catch(err => console.log(`[ticket] could not post SMS flow in ticket: ${err.message}`));

        }

        await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });

    },

    async sms_provider_select(interaction){
        smsSessions.set(interaction.user.id, { provider: interaction.values[0] });

        const embed = brandEmbed({
            title: "📱 Number Rental",
            fields: [{ name: "Provider", value: interaction.values[0], inline: true }],
            description: "Now pick a service:"
        });

        const menu = new StringSelectMenuBuilder()
            .setCustomId("sms_service_select")
            .setPlaceholder("Choose a service...")
            .addOptions(CONFIG.SMS_SERVICES.map(s => ({ label: s.label, value: s.value })));

        await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
    },

    async sms_service_select(interaction){
        const session = smsSessions.get(interaction.user.id) || {};
        session.service = interaction.values[0];
        smsSessions.set(interaction.user.id, session);

        const embed = brandEmbed({
            title: "📱 Number Rental",
            fields: [
                { name: "Provider", value: session.provider, inline: true },
                { name: "Service", value: session.service, inline: true }
            ],
            description: "Now pick a region:"
        });

        const menu = new StringSelectMenuBuilder()
            .setCustomId("sms_country_select")
            .setPlaceholder("Choose a region...")
            .addOptions(CONFIG.SMS_COUNTRIES.map(c => ({ label: c.label, value: c.value })));

        await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
    },

    async sms_country_select(interaction){
        const session = smsSessions.get(interaction.user.id) || {};
        session.country = interaction.values[0];
        smsSessions.set(interaction.user.id, session);

        const embed = brandEmbed({
            title: "📱 Number Rental",
            fields: [
                { name: "Provider", value: session.provider, inline: true },
                { name: "Service", value: session.service, inline: true },
                { name: "Region", value: session.country, inline: true }
            ],
            description: "Ready to buy."
        });

        const buy = new ButtonBuilder().setCustomId("sms_buy").setLabel("💳 Buy Number").setStyle(ButtonStyle.Success);

        await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(buy)] });
    }

};

// ---------------------------------------------------------------------------
// MODAL HANDLERS
// ---------------------------------------------------------------------------

const modalHandlers = {

    async vouch_form(interaction){

        const rating = Math.min(5, Math.max(1, parseInt(interaction.fields.getTextInputValue("rating")) || 5));
        const comment = interaction.fields.getTextInputValue("comment");
        const userId = interaction.user.id;

        // Don't post yet - wait for the proof photo so everything goes out
        // as ONE combined message instead of two separate ones.
        const existing = pendingVouchPhotos.get(userId);
        if(existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            pendingVouchPhotos.delete(userId);
        }, CONFIG.VOUCH_PHOTO_WINDOW_MS);

        pendingVouchPhotos.set(userId, {
            content: `**Rating:** ${"⭐".repeat(rating)}\n**Comment:** ${comment}`,
            rating,
            timestamp: Date.now(),
            textMessageId: null, // no channel message to clean up - this came from a modal
            timer
        });

        const leaveVouchMention = CONFIG.LEAVE_VOUCH_CHANNEL_ID
            ? `<#${CONFIG.LEAVE_VOUCH_CHANNEL_ID}>`
            : "the leave-vouch channel";

        await interaction.reply({
            content: `✅ Got your review! Now post a screenshot in ${leaveVouchMention} within 5 minutes to complete your vouch.`,
            ephemeral: true
        });

    }

};

// ---------------------------------------------------------------------------
// LEAVE-VOUCH CHANNEL: text + 5-min photo-proof window, then cleanup
// ---------------------------------------------------------------------------

async function handleLeaveVouchMessage(message){

    if(message.author.bot) return;

    if(!CONFIG.LEAVE_VOUCH_CHANNEL_ID){
        return; // not configured, nothing to do
    }

    if(message.channel.id !== CONFIG.LEAVE_VOUCH_CHANNEL_ID){
        return; // wrong channel, ignore
    }

    console.log(`[leave-vouch] message from ${message.author.tag} in leave-vouch channel`);

    if(!CONFIG.VOUCH_CHANNEL_ID){
        console.log("[leave-vouch] ⚠️ VOUCH_CHANNEL_ID is not set — cannot post vouches. Set it in your env vars.");
    }

    // Robust image check: contentType is preferred, but Discord doesn't always
    // populate it, so fall back to checking the file extension in the URL.
    const imageAttachment = message.attachments.find(a => {
        if(a.contentType && a.contentType.startsWith("image/")) return true;
        return /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(a.url || a.name || "");
    });

    const hasImage = !!imageAttachment;
    console.log(`[leave-vouch] hasImage=${hasImage} attachments=${message.attachments.size}`);

    const userId = message.author.id;
    const pending = pendingVouchPhotos.get(userId);

    async function postVouch(content, imageAttachment, rating){

        if(!CONFIG.VOUCH_CHANNEL_ID){
            console.log("[leave-vouch] skipped posting - no VOUCH_CHANNEL_ID configured");
            return false;
        }

        const channel = await message.guild.channels.fetch(CONFIG.VOUCH_CHANNEL_ID).catch(err => {
            console.log(`[leave-vouch] ❌ could not fetch vouch channel: ${err.message}`);
            return null;
        });

        if(!channel){
            console.log("[leave-vouch] ❌ vouch channel not found - check VOUCH_CHANNEL_ID and bot permissions");
            return false;
        }

        const embed = brandEmbed({
            title: "⭐ New Vouch",
            description: content || "*(no message)*"
        }).setAuthor({
            name: message.author.tag,
            iconURL: message.author.displayAvatarURL()
        });

        // Re-upload the proof photo as its own attachment instead of pointing
        // the embed at the original message's CDN url. The original message
        // gets deleted right after this, and Discord's CDN link for a deleted
        // message's attachment often falls back to serving a blurred/low-res
        // proxy version - so we grab the bytes now and give the vouch channel
        // its own independent copy of the image.
        const files = [];
        const rehosted = await rehostAttachment(imageAttachment, "vouch-proof.png");
        if(rehosted){
            files.push(rehosted);
            embed.setImage(`attachment://${rehosted.name}`);
        }else if(imageAttachment){
            console.log("[leave-vouch] ⚠️ rehost failed, falling back to direct url (may appear blurred)");
            embed.setImage(imageAttachment.url);
        }

        let sendSucceeded = true;
        await channel.send({ embeds: [embed], files }).catch(err => {
            console.log(`[leave-vouch] ❌ failed to send vouch embed: ${err.message}`);
            sendSucceeded = false;
        });

        if(!sendSucceeded) return false;

        console.log("[leave-vouch] ✅ posted vouch to vouch channel");

        const stats = vouchesDB.read();
        stats.entries.push({ user: userId, comment: content, rating: rating || null, at: new Date().toISOString() });
        stats.totalVouches++;
        if(rating){
            stats.ratingSum = (stats.ratingSum || 0) + rating;
            stats.ratingCount = (stats.ratingCount || 0) + 1;
        }
        vouchesDB.write(stats);

        const users = usersDB.read();
        users[userId] = users[userId] || { vouches: 0 };
        users[userId].vouches++;
        usersDB.write(users);

        return true;

    }

    // Case 1: message includes a photo - either completes a pending text
    // vouch, or stands alone as a photo-only vouch.
    if(hasImage){

        if(pending && Date.now() - pending.timestamp < CONFIG.VOUCH_PHOTO_WINDOW_MS){

            console.log("[leave-vouch] photo completes pending text vouch");
            clearTimeout(pending.timer);

            const posted = await postVouch(pending.content, imageAttachment, pending.rating);

            if(posted){
                if(pending.textMessageId){
                    const original = await message.channel.messages.fetch(pending.textMessageId).catch(err => {
                        console.log(`[leave-vouch] could not fetch original text message: ${err.message}`);
                        return null;
                    });
                    if(original) await original.delete().catch(err => console.log(`[leave-vouch] could not delete text message: ${err.message}`));
                }
                await message.delete().catch(err => console.log(`[leave-vouch] could not delete photo message: ${err.message}`));
            }

            pendingVouchPhotos.delete(userId);

        }else{

            console.log("[leave-vouch] standalone photo vouch (no pending text, or window expired)");
            const posted = await postVouch(message.content, imageAttachment);
            if(posted){
                await message.delete().catch(err => console.log(`[leave-vouch] could not delete photo message: ${err.message}`));
            }

        }

        return;
    }

    // Case 2: text-only message - start the 5 minute proof-photo window
    console.log(`[leave-vouch] text-only message, starting ${CONFIG.VOUCH_PHOTO_WINDOW_MS / 60000}min photo window`);

    const timer = setTimeout(async () => {

        const stillPending = pendingVouchPhotos.get(userId);
        if(!stillPending) return; // already fulfilled by a photo

        pendingVouchPhotos.delete(userId);
        console.log(`[leave-vouch] photo window expired for ${userId}, deleting original message`);

        const original = await message.channel.messages.fetch(stillPending.textMessageId).catch(err => {
            console.log(`[leave-vouch] could not fetch expired message to delete: ${err.message}`);
            return null;
        });
        if(original) await original.delete().catch(err => console.log(`[leave-vouch] could not delete expired message: ${err.message}`));

    }, CONFIG.VOUCH_PHOTO_WINDOW_MS);

    pendingVouchPhotos.set(userId, {
        content: message.content,
        timestamp: Date.now(),
        textMessageId: message.id,
        timer
    });

}

module.exports = {
    CONFIG,
    slashCommands,
    buttonHandlers,
    selectHandlers,
    modalHandlers,
    giveawaysDB,
    handleLeaveVouchMessage
};
