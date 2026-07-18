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

    TICKET_SERVICES: [
        { label: "Champions Quest Support", value: "champions", emoji: "🏆" },
        { label: "Warzone Rank Boost", value: "warzone", emoji: "⚔️" },
        { label: "Multiplayer Rank Boost", value: "multiplayer", emoji: "🔥" }
    ]
};

function countrySlug(value, provider){
    const entry = CONFIG.SMS_COUNTRIES.find(c => c.value === value);
    return entry ? entry.slugs[provider] : value;
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

            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} ${CONFIG.BRAND_NAME.toUpperCase()}`)
                .setDescription(
                    "# ⭐ CUSTOMER REVIEWS\n\n" +
                    `Thank you for choosing **${CONFIG.BRAND_NAME}**.\n\n` +
                    "We appreciate your honest feedback and support.\n\n" +
                    "━━━━━━━━━━━━━━━━━━━━\n\n" +
                    "⭐ **Rating**\nChoose your experience from 1-5 stars.\n\n" +
                    "💬 **Feedback**\nTell us about your experience.\n\n" +
                    "📸 **Proof**\nDrop a screenshot in this channel within 5 minutes of leaving your vouch.\n\n" +
                    "━━━━━━━━━━━━━━━━━━━━\n\n" +
                    "Click the button below to leave your review."
                )
                .setFooter({ text: `${CONFIG.BRAND_NAME} • Vouch System` })
                .setTimestamp();

            const button = new ButtonBuilder()
                .setCustomId("leave_vouch")
                .setLabel("📝 Leave a Vouch")
                .setStyle(ButtonStyle.Danger);

            await interaction.reply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(button)]
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

            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} ${CONFIG.BRAND_NAME} - Open a Ticket`)
                .setDescription("Pick what you need below and a private channel will be created for you.")
                .setFooter({ text: CONFIG.BRAND_NAME });

            const menu = new StringSelectMenuBuilder()
                .setCustomId("ticket_select")
                .setPlaceholder("Choose a service...")
                .addOptions(CONFIG.TICKET_SERVICES.map(s => ({
                    label: s.label, value: s.value, emoji: s.emoji
                })));

            await interaction.reply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(menu)]
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

            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} ${CONFIG.BRAND_NAME.toUpperCase()} STATS`)
                .setDescription(
                    `📊 **Total Vouches**\n${stats.totalVouches}\n\n` +
                    `⭐ **Average Rating**\n${avg}/5\n\n` +
                    `🏆 **Reputation**\n${avg >= 4.5 ? "Excellent ⭐⭐⭐⭐⭐" : "Growing ⭐⭐⭐⭐"}`
                )
                .setFooter({ text: `${CONFIG.BRAND_NAME} • Statistics` })
                .setTimestamp();

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

            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} TOP CUSTOMERS`)
                .setDescription(lines)
                .setFooter({ text: CONFIG.BRAND_NAME });

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

            const embed = new EmbedBuilder()
                .setColor("#b026ff")
                .setTitle("🎉 GIVEAWAY")
                .setDescription(`🎁 **Prize**\n${prize}\n\nEnds <t:${Math.floor(endTime / 1000)}:R>`)
                .setTimestamp();

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

            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} NUMBER RENTAL`)
                .setDescription("Pick a provider to get started.")
                .setFooter({ text: `${CONFIG.BRAND_NAME} • SMS Verification` });

            const menu = new StringSelectMenuBuilder()
                .setCustomId("sms_provider_select")
                .setPlaceholder("Choose a provider...")
                .addOptions(
                    { label: "5sim", value: "5sim", emoji: "5️⃣" },
                    { label: "SMSPool", value: "smspool", emoji: "🌀" }
                );

            await interaction.reply({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(menu)],
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
            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} RECENT NUMBER ORDERS`)
                .setDescription(lines)
                .setFooter({ text: `${CONFIG.BRAND_NAME} • Staff Log` });
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

            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} ${CONFIG.BRAND_NAME} — Commands`)
                .setDescription(lines)
                .setFooter({ text: CONFIG.BRAND_NAME });

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

            const embed = new EmbedBuilder()
                .setColor(CONFIG.COLOR)
                .setTitle(`${CONFIG.BRAND_EMOJI} BOT STATUS`)
                .setDescription(
                    `${lines}\n\n` +
                    `📢 **Vouch channel:** ${vouchChannelOk}\n` +
                    `📝 **Leave-vouch channel:** ${leaveVouchChannelOk}\n\n` +
                    `If anything above is ❌, that's almost certainly why a feature is failing.`
                )
                .setFooter({ text: CONFIG.BRAND_NAME })
                .setTimestamp();

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

        const embed = new EmbedBuilder()
            .setColor(CONFIG.COLOR)
            .setTitle(`${CONFIG.BRAND_EMOJI} NUMBER READY`)
            .setDescription(`☎️ **Number**\n${purchase.phone}\n\n🧾 **Order**\n${orderId}`)
            .setFooter({ text: `${CONFIG.BRAND_NAME} • SMS Verification` });

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

        const channel = await interaction.guild.channels.create({
            name: `ticket-${interaction.user.username}`.toLowerCase(),
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
            ]
        });

        const embed = new EmbedBuilder()
            .setColor(CONFIG.COLOR)
            .setTitle(`${CONFIG.BRAND_EMOJI} Order Setup`)
            .setDescription(`👤 **Customer**\n${interaction.user}\n\n🎯 **Service**\n${service.emoji} ${service.label}\n\nA staff member will help finalize your order.`)
            .setFooter({ text: CONFIG.BRAND_NAME });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("claim_ticket").setLabel("🙋 Claim").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("close_ticket").setLabel("🔒 Close").setStyle(ButtonStyle.Danger)
        );

        await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });

        const log = ticketLogDB.read();
        log.open.push({ channelId: channel.id, user: interaction.user.id, service: choice, created: new Date().toISOString() });
        ticketLogDB.write(log);

        await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });

    },

    async sms_provider_select(interaction){
        smsSessions.set(interaction.user.id, { provider: interaction.values[0] });

        const embed = new EmbedBuilder()
            .setColor(CONFIG.COLOR)
            .setTitle(`${CONFIG.BRAND_EMOJI} NUMBER RENTAL`)
            .setDescription(`Provider: **${interaction.values[0]}**\n\nNow pick a service:`)
            .setFooter({ text: `${CONFIG.BRAND_NAME} • SMS Verification` });

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

        const embed = new EmbedBuilder()
            .setColor(CONFIG.COLOR)
            .setTitle(`${CONFIG.BRAND_EMOJI} NUMBER RENTAL`)
            .setDescription(`Provider: **${session.provider}** | Service: **${session.service}**\n\nNow pick a region:`)
            .setFooter({ text: `${CONFIG.BRAND_NAME} • SMS Verification` });

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

        const embed = new EmbedBuilder()
            .setColor(CONFIG.COLOR)
            .setTitle(`${CONFIG.BRAND_EMOJI} NUMBER RENTAL`)
            .setDescription(`Provider: **${session.provider}**\nService: **${session.service}**\nRegion: **${session.country}**\n\nReady to buy.`)
            .setFooter({ text: `${CONFIG.BRAND_NAME} • SMS Verification` });

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

        const embed = new EmbedBuilder()
            .setColor(CONFIG.COLOR)
            .setTitle("⭐ New Vouch")
            .setDescription(`**From:** <@${userId}>\n**Message:** ${content || "*(no message)*"}`)
            .setTimestamp();

        if(imageUrl) embed.setImage(imageUrl);

        let sendSucceeded = true;
        await channel.send({ embeds: [embed] }).catch(err => {
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

module.exports = {
    CONFIG,
    slashCommands,
    buttonHandlers,
    selectHandlers,
    modalHandlers,
    giveawaysDB,
    handleLeaveVouchMessage
};
