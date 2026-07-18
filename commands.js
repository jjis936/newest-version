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
    ChannelType
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
    WELCOME_CHANNEL_ID: process.env.WELCOME_CHANNEL_ID || null,
    AUTOROLE_ID: process.env.AUTOROLE_ID || null,
    TRANSCRIPT_CHANNEL_ID: process.env.TRANSCRIPT_CHANNEL_ID || null,

    TICKET_SERVICES: [
        { label: "Nuke Services", value: "nuke", emoji: { id: "1524910404814503936" } },
        { label: "WZ Ranked Boost", value: "wz_ranked", emoji: { id: "1528069396302659606" } },
        { label: "MP Ranked Boost", value: "mp_ranked", emoji: { id: "1528069396302659606" } },
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

const vouchesDB = db("vouches", { entries: [], totalVouches: 0, ratingSum: 0 });
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
            const avg = stats.totalVouches
                ? (stats.ratingSum / stats.totalVouches).toFixed(1)
                : "0.0";

            const embed = brandEmbed({
                title: `${CONFIG.BRAND_NAME} Statistics`,
                fields: [
                    { name: "📊 Total Vouches", value: `${stats.totalVouches}`, inline: true },
                    { name: "⭐ Average Rating", value: `${avg}/5`, inline: true },
                    { name: "🏆 Reputation", value: avg >= 4.5 ? "Excellent ⭐⭐⭐⭐⭐" : "Growing ⭐⭐⭐⭐", inline: true }
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

    // -- Bulk delete messages (staff) ---------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("clear")
            .setDescription("Staff: bulk delete messages in this channel")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
            .addIntegerOption(o => o.setName("amount").setDescription("How many messages (1-100)").setRequired(true)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const amount = Math.min(100, Math.max(1, interaction.options.getInteger("amount")));

            await interaction.deferReply({ ephemeral: true });
            const deleted = await interaction.channel.bulkDelete(amount, true).catch(err => {
                console.log(`[clear] ${err.message}`);
                return null;
            });

            await interaction.editReply({
                content: deleted
                    ? `🧹 Deleted ${deleted.size} messages (Discord only allows bulk-deleting messages under 14 days old).`
                    : "❌ Couldn't delete messages - check the bot has Manage Messages here."
            });
        }
    },

    // -- Poll -----------------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("poll")
            .setDescription("Start a quick yes/no poll")
            .addStringOption(o => o.setName("question").setDescription("The question").setRequired(true)),

        async execute(interaction){
            const question = interaction.options.getString("question");

            const embed = brandEmbed({
                title: "📊 Poll",
                description: question,
                thumbnail: false
            }).setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() });

            const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
            await msg.react("✅").catch(() => {});
            await msg.react("❌").catch(() => {});
        }
    },

    // -- Personal reminder ---------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("remindme")
            .setDescription("Get pinged with a reminder later")
            .addIntegerOption(o => o.setName("minutes").setDescription("How many minutes from now").setRequired(true))
            .addStringOption(o => o.setName("about").setDescription("What to remind you about").setRequired(true)),

        async execute(interaction){
            const minutes = interaction.options.getInteger("minutes");
            const about = interaction.options.getString("about");

            await interaction.reply({
                content: `⏰ Got it — I'll remind you about **${about}** in ${minutes} minute(s).`,
                ephemeral: true
            });

            setTimeout(() => {
                interaction.followUp({
                    content: `⏰ ${interaction.user} reminder: **${about}**`
                }).catch(() => {});
            }, minutes * 60000);
        }
    },

    // -- Magic 8-ball -----------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("8ball")
            .setDescription("Ask the magic 8-ball a question")
            .addStringOption(o => o.setName("question").setDescription("Your question").setRequired(true)),

        async execute(interaction){
            const answers = [
                "It is certain.", "Without a doubt.", "Yes, definitely.", "You may rely on it.",
                "Most likely.", "Outlook good.", "Signs point to yes.", "Reply hazy, try again.",
                "Ask again later.", "Better not tell you now.", "Don't count on it.",
                "My reply is no.", "Outlook not so good.", "Very doubtful."
            ];
            const answer = answers[Math.floor(Math.random() * answers.length)];

            const embed = brandEmbed({
                title: "🎱 Magic 8-Ball",
                fields: [
                    { name: "Question", value: interaction.options.getString("question") },
                    { name: "Answer", value: answer }
                ]
            });

            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- Coinflip -------------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("coinflip")
            .setDescription("Flip a coin"),

        async execute(interaction){
            const result = Math.random() < 0.5 ? "Heads" : "Tails";
            await interaction.reply({ content: `🪙 **${result}!**` });
        }
    },

    // -- Provider balance check (staff) --------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("balance")
            .setDescription("Staff: check 5sim/SMSPool account balances")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            let fivesimBalance = "❌ not configured";
            let smspoolBalance = "❌ not configured";

            if(process.env.FIVESIM_API_KEY){
                try{
                    const res = await fetch("https://5sim.net/v1/user/profile", {
                        headers: { Authorization: `Bearer ${process.env.FIVESIM_API_KEY}` }
                    });
                    const data = await res.json();
                    fivesimBalance = res.ok ? `$${data.balance}` : `❌ ${data.message || "error"}`;
                }catch(err){
                    fivesimBalance = `❌ ${err.message}`;
                }
            }

            if(process.env.SMSPOOL_API_KEY){
                try{
                    const params = new URLSearchParams({ key: process.env.SMSPOOL_API_KEY });
                    const res = await fetch("https://api.smspool.net/request/balance", { method: "POST", body: params });
                    const data = await res.json();
                    smspoolBalance = data.balance !== undefined ? `$${data.balance}` : `❌ ${data.message || "error"}`;
                }catch(err){
                    smspoolBalance = `❌ ${err.message}`;
                }
            }

            const embed = brandEmbed({
                title: "💰 Provider Balances",
                fields: [
                    { name: "5sim", value: fivesimBalance, inline: true },
                    { name: "SMSPool", value: smspoolBalance, inline: true }
                ]
            });

            await interaction.editReply({ embeds: [embed] });
        }
    },

    // -- Staff announcement ---------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("announce")
            .setDescription("Staff: post a formatted announcement")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addChannelOption(o => o.setName("channel").setDescription("Where to post").setRequired(true))
            .addStringOption(o => o.setName("title").setDescription("Announcement title").setRequired(true))
            .addStringOption(o => o.setName("message").setDescription("Announcement body").setRequired(true)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }

            const channel = interaction.options.getChannel("channel");
            const title = interaction.options.getString("title");
            const message = interaction.options.getString("message");

            const embed = brandEmbed({ title: `📢 ${title}`, description: message });

            await channel.send({ embeds: [embed] }).catch(err => {
                return interaction.reply({ content: `❌ Couldn't post there: ${err.message}`, ephemeral: true });
            });

            await interaction.reply({ content: `✅ Posted in ${channel}`, ephemeral: true });
        }
    },

    // -- COD: Random loadout generator ---------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("loadout")
            .setDescription("Generate a random loadout - great for challenge runs"),

        async execute(interaction){
            const primaries = ["MCW", "Kastov 762", "SVA 545", "Lachmann-556", "M4", "RAM-7", "Holger 556", "TAQ-56"];
            const secondaries = ["X13 Auto", "Basilisk", "COR-45", "WSP Stinger", "Renetti"];
            const perks = ["Double Time", "Scavenger", "Ghost", "Cold-Blooded", "Tempered", "Bomb Squad", "High Alert", "Fast Hands"];
            const killstreaks = ["UAV", "Counter UAV", "Cluster Mine", "Precision Airstrike", "Chopper Gunner", "VTOL"];
            const equipment = ["Flash Grenade", "Semtex", "Proximity Mine", "Stun Grenade", "Smoke Grenade"];

            const pick = arr => arr[Math.floor(Math.random() * arr.length)];
            const pickN = (arr, n) => [...arr].sort(() => 0.5 - Math.random()).slice(0, n);

            const embed = brandEmbed({
                title: "🎯 Random Loadout Challenge",
                fields: [
                    { name: "Primary", value: pick(primaries), inline: true },
                    { name: "Secondary", value: pick(secondaries), inline: true },
                    { name: "Equipment", value: pick(equipment), inline: true },
                    { name: "Perks", value: pickN(perks, 3).join(", ") },
                    { name: "Killstreaks", value: pickN(killstreaks, 3).join(", ") }
                ]
            });

            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- COD: Random map picker -----------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("randommap")
            .setDescription("Pick a random map to play")
            .addStringOption(o => o.setName("mode").setDescription("Map pool").setRequired(true)
                .addChoices({ name: "Multiplayer", value: "mp" }, { name: "Warzone", value: "wz" })),

        async execute(interaction){
            const mode = interaction.options.getString("mode");
            const mpMaps = ["Rust", "Nuketown", "Skidrow", "Highrise", "Shipment", "Terminal", "Karachi", "Invasion"];
            const wzMaps = ["Verdansk", "Rebirth Island", "Fortune's Keep", "Al Mazrah", "Vondel", "Ashika Island"];

            const pool = mode === "mp" ? mpMaps : wzMaps;
            const map = pool[Math.floor(Math.random() * pool.length)];

            await interaction.reply({ content: `🗺️ Your map: **${map}**` });
        }
    },

    // -- COD: Gulag simulator ---------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("gulag")
            .setDescription("Simulate a 1v1 gulag fight between two people")
            .addUserOption(o => o.setName("player1").setDescription("First fighter").setRequired(true))
            .addUserOption(o => o.setName("player2").setDescription("Second fighter").setRequired(true)),

        async execute(interaction){
            const p1 = interaction.options.getUser("player1");
            const p2 = interaction.options.getUser("player2");
            const winner = Math.random() < 0.5 ? p1 : p2;

            const embed = brandEmbed({
                title: "⛓️ Gulag",
                description: `${p1} vs ${p2}\n\n🏆 **Winner:** ${winner} is back in the fight!`
            });

            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- COD: Random camo challenge -------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("camochallenge")
            .setDescription("Get a random camo grind challenge"),

        async execute(interaction){
            const challenges = [
                "Get 3 kills without dying, 15 times",
                "Get 5 headshots in a single match, 10 times",
                "Win a gunfight from 50+ meters, 20 times",
                "Get 2 kills using the same magazine, 15 times",
                "Get a kill within 10 seconds of spawning, 15 times",
                "Get a kill while sliding or diving, 15 times",
                "Get 100 kills with this weapon",
                "Get 3 kills without using ADS, 10 times"
            ];
            const challenge = challenges[Math.floor(Math.random() * challenges.length)];

            const embed = brandEmbed({
                title: "🎨 Camo Grind Challenge",
                description: challenge
            });

            await interaction.reply({ embeds: [embed] });
        }
    },

    // -- Channel lock/unlock/slowmode (staff) --------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("lock")
            .setDescription("Staff: lock this channel so @everyone can't send messages")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false }).catch(err => {
                return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
            });
            await interaction.reply({ content: "🔒 Channel locked." });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName("unlock")
            .setDescription("Staff: unlock this channel")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null }).catch(err => {
                return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
            });
            await interaction.reply({ content: "🔓 Channel unlocked." });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName("slowmode")
            .setDescription("Staff: set slowmode for this channel")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addIntegerOption(o => o.setName("seconds").setDescription("0 to disable").setRequired(true)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const seconds = Math.max(0, Math.min(21600, interaction.options.getInteger("seconds")));
            await interaction.channel.setRateLimitPerUser(seconds).catch(err => {
                return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
            });
            await interaction.reply({ content: seconds ? `🐌 Slowmode set to ${seconds}s.` : "✅ Slowmode disabled." });
        }
    },

    // -- Nickname (staff) -----------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("nickname")
            .setDescription("Staff: change a member's nickname")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
            .addUserOption(o => o.setName("user").setDescription("Who to rename").setRequired(true))
            .addStringOption(o => o.setName("nickname").setDescription("New nickname (leave blank to reset)").setRequired(false)),

        async execute(interaction){
            if(!interaction.member.permissions.has(PermissionFlagsBits.ManageNicknames)){
                return interaction.reply({ content: "❌ No permission.", ephemeral: true });
            }
            const user = interaction.options.getUser("user");
            const nickname = interaction.options.getString("nickname") || null;
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if(!member) return interaction.reply({ content: "❌ User not found.", ephemeral: true });

            await member.setNickname(nickname).catch(err => {
                return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
            });
            await interaction.reply({ content: `✅ Updated ${user}'s nickname.`, ephemeral: true });
        }
    },

    // -- Uptime -----------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("uptime")
            .setDescription("See how long the bot has been running"),

        async execute(interaction){
            const totalSeconds = Math.floor(process.uptime());
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            await interaction.reply({ content: `⏱️ Uptime: **${h}h ${m}m ${s}s**` });
        }
    },

    // -- Timestamp converter --------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("timestamp")
            .setDescription("Convert minutes-from-now into a Discord dynamic timestamp")
            .addIntegerOption(o => o.setName("minutes").setDescription("Minutes from now").setRequired(true)),

        async execute(interaction){
            const minutes = interaction.options.getInteger("minutes");
            const ts = Math.floor((Date.now() + minutes * 60000) / 1000);
            await interaction.reply({
                content: `🕐 <t:${ts}:F> (<t:${ts}:R>)\nRaw: \`<t:${ts}:F>\``,
                ephemeral: true
            });
        }
    },

    // -- Invite link ------------------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("invite")
            .setDescription("Get an invite link for this bot"),

        async execute(interaction){
            const url = `https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=8&scope=bot%20applications.commands`;
            await interaction.reply({ content: `🔗 [Click here to invite me to another server](${url})`, ephemeral: true });
        }
    },

    // -- Server setup (the big one) ------------------------------------------
    {
        data: new SlashCommandBuilder()
            .setName("setup")
            .setDescription("Staff: create all the standard Sinner Services categories & channels")
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        async execute(interaction){

            if(!interaction.member.permissions.has(PermissionFlagsBits.Administrator)){
                return interaction.reply({ content: "❌ You need Administrator to run this.", ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const guild = interaction.guild;
            const created = { categories: 0, text: 0, voice: 0 };
            const results = { vouchChannelId: null, leaveVouchChannelId: null, ticketPanelChannelId: null };
            const newlyCreated = { ticketsChannel: null, leaveVouchChannel: null };

            // Structure to build: [categoryName, [ [channelName, type], ... ] ]
            const structure = [
                [
                    "『SERVER』",
                    [
                        ["announcements", "text"],
                        ["air-port", "text"],
                        ["air-port-2", "text"],
                        ["giveaways", "text"],
                        ["website", "text"],
                        ["payment-methods", "text"]
                    ]
                ],
                [
                    "Sinner Lounge",
                    [
                        ["chat", "text"],
                        ["wz-lfg", "text"],
                        ["mp-lfg", "text"]
                    ]
                ],
                [
                    "Sinner Services",
                    [
                        ["accounts", "text"],
                        ["champions-quest", "text"],
                        ["wz-ranked-boost", "text"],
                        ["mp-ranked-boost", "text"],
                        ["wz-ranked-ready", "text"],
                        ["vouches", "text"],
                        ["leave-a-vouch", "text"],
                        ["tickets", "text"]
                    ]
                ],
                [
                    "Sinner Voice Channels",
                    [
                        ["commands", "text"],
                        ["Lounge", "voice"]
                    ]
                ]
            ];

            try{

                for(const [categoryName, channels] of structure){

                    // Reuse an existing category with the same name instead of
                    // making a duplicate if you run /setup more than once.
                    let category = guild.channels.cache.find(
                        c => c.type === ChannelType.GuildCategory && c.name === categoryName
                    );

                    if(!category){
                        category = await guild.channels.create({
                            name: categoryName,
                            type: ChannelType.GuildCategory
                        });
                        created.categories++;
                    }

                    for(const [channelName, kind] of channels){

                        const exists = guild.channels.cache.find(
                            c => c.name === channelName && c.parentId === category.id
                        );
                        if(exists){
                            if(channelName === "vouches") results.vouchChannelId = exists.id;
                            if(channelName === "leave-a-vouch") results.leaveVouchChannelId = exists.id;
                            if(channelName === "tickets") results.ticketPanelChannelId = exists.id;
                            continue;
                        }

                        const channel = await guild.channels.create({
                            name: channelName,
                            type: kind === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText,
                            parent: category.id
                        });

                        if(kind === "voice") created.voice++; else created.text++;

                        if(channelName === "vouches") results.vouchChannelId = channel.id;
                        if(channelName === "leave-a-vouch"){
                            results.leaveVouchChannelId = channel.id;
                            newlyCreated.leaveVouchChannel = channel;
                        }
                        if(channelName === "tickets"){
                            results.ticketPanelChannelId = channel.id;
                            newlyCreated.ticketsChannel = channel;
                        }

                    }

                }

            }catch(err){
                console.log(`[setup] ❌ ${err.message}`);
                return interaction.editReply({
                    content: `❌ Setup failed partway through (\`${err.message}\`). This is almost always missing **Manage Channels** on the bot's role. Check the permissions and run \`/setup\` again - it skips anything already created.`
                });
            }

            const needsEnvUpdate =
                results.vouchChannelId !== CONFIG.VOUCH_CHANNEL_ID ||
                results.leaveVouchChannelId !== CONFIG.LEAVE_VOUCH_CHANNEL_ID;

            // Auto-post the ticket panel in the new #tickets channel
            if(newlyCreated.ticketsChannel){
                const ticketEmbed = brandEmbed({
                    title: "Choose Your Service",
                    description: "Select an option below and a private ticket will be created just for you.",
                    fields: [{
                        name: "How it works",
                        value: "1️⃣ Pick a service from the dropdown\n2️⃣ A private channel opens for you\n3️⃣ Staff will claim & assist you there"
                    }]
                });
                const ticketMenu = new StringSelectMenuBuilder()
                    .setCustomId("ticket_select")
                    .setPlaceholder("Services")
                    .addOptions(CONFIG.TICKET_SERVICES.map(s => ({ label: s.label, value: s.value, emoji: s.emoji })));

                await newlyCreated.ticketsChannel.send({
                    embeds: [ticketEmbed],
                    components: [new ActionRowBuilder().addComponents(ticketMenu), websiteRow()]
                }).catch(err => console.log(`[setup] could not post ticket panel: ${err.message}`));
            }

            // Auto-post the "Leave a Vouch" panel in the new #leave-a-vouch channel
            if(newlyCreated.leaveVouchChannel){
                const vouchEmbed = brandEmbed({
                    title: "⭐ Customer Reviews",
                    description: `Thank you for choosing **${CONFIG.BRAND_NAME}**. We appreciate your honest feedback.`,
                    fields: [
                        { name: "⭐ Rating", value: "Rate your experience from 1–5 stars.", inline: true },
                        { name: "💬 Feedback", value: "Tell us how it went.", inline: true },
                        { name: "📸 Proof", value: "Drop a screenshot in this channel within 5 minutes of submitting.", inline: true }
                    ]
                });
                const vouchButton = new ButtonBuilder()
                    .setCustomId("leave_vouch")
                    .setLabel("📝 Leave a Vouch")
                    .setStyle(ButtonStyle.Danger);

                await newlyCreated.leaveVouchChannel.send({
                    embeds: [vouchEmbed],
                    components: [new ActionRowBuilder().addComponents(vouchButton), websiteRow()]
                }).catch(err => console.log(`[setup] could not post vouch panel: ${err.message}`));
            }

            const embed = brandEmbed({
                title: "✅ Server Setup Complete",
                fields: [
                    { name: "📁 Categories created", value: `${created.categories}`, inline: true },
                    { name: "💬 Text channels created", value: `${created.text}`, inline: true },
                    { name: "🔊 Voice channels created", value: `${created.voice}`, inline: true },
                    { name: "⭐ Vouches channel", value: `<#${results.vouchChannelId}>`, inline: true },
                    { name: "📝 Leave-a-vouch channel", value: `<#${results.leaveVouchChannelId}>`, inline: true },
                    { name: "🎫 Tickets channel", value: `<#${results.ticketPanelChannelId}>`, inline: true }
                ],
                description: needsEnvUpdate
                    ? "⚠️ These channel IDs don't match your current `VOUCH_CHANNEL_ID` / `LEAVE_VOUCH_CHANNEL_ID` env vars - update them in Railway to the IDs above so the vouch system posts in the right place."
                    : "Everything matches your current config - no env var changes needed."
            });

            await interaction.editReply({ embeds: [embed] });

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

            // The definitive answer to "does the bot actually have permission X" -
            // no more guessing based on symptoms.
            const botMember = interaction.guild.members.me;
            const botPerms = [
                "ManageChannels", "ManageRoles", "ManageMessages",
                "SendMessages", "ViewChannel", "ManageNicknames", "ModerateMembers"
            ].map(p => `${botMember.permissions.has(PermissionFlagsBits[p]) ? "✅" : "❌"} ${p}`).join("\n");

            const lines = checks.map(([name, ok]) => `${ok ? "✅" : "❌"} ${name}`).join("\n");

            const embed = brandEmbed({
                title: "🩺 Bot Status",
                fields: [
                    { name: "Environment", value: lines },
                    { name: "📢 Vouch channel", value: vouchChannelOk },
                    { name: "📝 Leave-vouch channel", value: leaveVouchChannelOk },
                    { name: "🔑 Bot's actual server permissions", value: botPerms }
                ],
                description: "If anything above is ❌, that's almost certainly why a feature is failing."
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
        await interaction.reply({ content: "🔒 Generating transcript, then closing in 5 seconds..." });

        try{
            const messages = await interaction.channel.messages.fetch({ limit: 100 });
            const sorted = [...messages.values()].reverse();

            const lines = sorted.map(m => {
                const time = new Date(m.createdTimestamp).toISOString();
                const content = m.content || (m.embeds.length ? "[embed]" : "[no content]");
                return `[${time}] ${m.author.tag}: ${content}`;
            });

            const transcript = lines.join("\n") || "No messages.";
            const buffer = Buffer.from(transcript, "utf8");
            const file = { attachment: buffer, name: `${interaction.channel.name}-transcript.txt` };

            if(CONFIG.TRANSCRIPT_CHANNEL_ID){
                const logChannel = await interaction.guild.channels.fetch(CONFIG.TRANSCRIPT_CHANNEL_ID).catch(() => null);
                if(logChannel){
                    await logChannel.send({
                        content: `📄 Transcript for **#${interaction.channel.name}** (closed by ${interaction.user})`,
                        files: [file]
                    }).catch(err => console.log(`[ticket] could not post transcript to log channel: ${err.message}`));
                }else{
                    console.log("[ticket] TRANSCRIPT_CHANNEL_ID set but channel not found");
                }
            }else{
                console.log("[ticket] TRANSCRIPT_CHANNEL_ID not set - transcript generated but not saved anywhere");
            }

        }catch(err){
            console.log(`[ticket] could not generate transcript: ${err.message}`);
        }

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

    async function postVouch(content, imageUrl){

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

        // Important: don't just link the original attachment URL - Discord
        // invalidates it once the source message is deleted, which is why
        // the image was disappearing. Download it and re-upload it fresh so
        // this new message owns its own copy of the image.
        let file = null;
        if(imageUrl){
            try{
                console.log(`[leave-vouch] fetching image for re-upload: ${imageUrl}`);
                const res = await fetch(imageUrl);

                if(!res.ok){
                    console.log(`[leave-vouch] ⚠️ image fetch returned ${res.status}, falling back to original URL`);
                    embed.setImage(imageUrl);
                }else{
                    const arrayBuffer = await res.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const extMatch = imageUrl.match(/\.(png|jpe?g|gif|webp)(\?.*)?$/i);
                    const ext = extMatch ? extMatch[1].toLowerCase() : "png";
                    const filename = `vouch-proof.${ext}`;

                    console.log(`[leave-vouch] downloaded ${buffer.length} bytes, re-uploading as ${filename}`);

                    file = { attachment: buffer, name: filename };
                    embed.setImage(`attachment://${filename}`);
                }
            }catch(err){
                console.log(`[leave-vouch] ⚠️ could not re-upload image, falling back to original URL: ${err.message}`);
                embed.setImage(imageUrl);
            }
        }

        let sendSucceeded = true;
        const sendPayload = { embeds: [embed] };
        if(file) sendPayload.files = [file];

        await channel.send(sendPayload).catch(err => {
            console.log(`[leave-vouch] ❌ failed to send vouch embed: ${err.message}`);
            sendSucceeded = false;
        });

        if(!sendSucceeded) return false;

        console.log("[leave-vouch] ✅ posted vouch to vouch channel");

        const stats = vouchesDB.read();
        stats.entries.push({ user: userId, comment: content, at: new Date().toISOString() });
        stats.totalVouches++;
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

            const posted = await postVouch(pending.content, imageAttachment.url);

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
            const posted = await postVouch(message.content, imageAttachment.url);
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

// ---------------------------------------------------------------------------
// WELCOME MESSAGE + AUTOROLE
// ---------------------------------------------------------------------------

async function handleNewMember(member){

    if(CONFIG.AUTOROLE_ID){
        await member.roles.add(CONFIG.AUTOROLE_ID).catch(err =>
            console.log(`[welcome] could not add autorole: ${err.message}`)
        );
    }

    if(CONFIG.WELCOME_CHANNEL_ID){
        const channel = await member.guild.channels.fetch(CONFIG.WELCOME_CHANNEL_ID).catch(() => null);
        if(channel){
            const embed = brandEmbed({
                title: `👋 Welcome to ${CONFIG.BRAND_NAME}!`,
                description: `${member} just joined. Check out <#${CONFIG.LEAVE_VOUCH_CHANNEL_ID || ""}> or open a ticket to get started.`,
                thumbnail: false
            }).setThumbnail(member.user.displayAvatarURL());

            await channel.send({ embeds: [embed] }).catch(err =>
                console.log(`[welcome] could not send welcome message: ${err.message}`)
            );
        }
    }

}

module.exports = {
    CONFIG,
    slashCommands,
    buttonHandlers,
    selectHandlers,
    modalHandlers,
    giveawaysDB,
    handleLeaveVouchMessage,
    handleNewMember
};
