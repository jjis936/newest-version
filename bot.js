// bot.js
// Everything the bot does at runtime lives here: client setup, routing
// interactions to the right handler in commands.js, and the giveaway
// end-check loop. Slash command *registration* with Discord happens in
// deploy-commands.js (run automatically on boot, see package.json).

require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const {
    CONFIG,
    slashCommands,
    buttonHandlers,
    selectHandlers,
    modalHandlers,
    giveawaysDB,
    handleLeaveVouchMessage,
    handleNewMember
} = require("./commands");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Build a quick lookup map: commandName -> execute()
const commandMap = new Map(slashCommands.map(c => [c.data.name, c.execute]));

client.once("clientReady", () => {
    console.log(`💎 ${client.user.tag} is online`);
    client.user.setActivity(`${CONFIG.BRAND_NAME} | Orders`);

    console.log("--- Config check ---");
    console.log("VOUCH_CHANNEL_ID:", CONFIG.VOUCH_CHANNEL_ID || "❌ NOT SET");
    console.log("LEAVE_VOUCH_CHANNEL_ID:", CONFIG.LEAVE_VOUCH_CHANNEL_ID || "❌ NOT SET");
    console.log("WEBSITE_URL:", CONFIG.WEBSITE_URL || "❌ NOT SET");
    console.log("--------------------");
});

client.on("interactionCreate", async (interaction) => {

    const label = interaction.isChatInputCommand() ? `/${interaction.commandName}`
        : interaction.customId ? `[${interaction.customId}]`
        : "[unknown interaction]";

    console.log(`[interaction] ${label} from ${interaction.user.tag}`);

    try{

        if(interaction.isChatInputCommand()){
            const execute = commandMap.get(interaction.commandName);
            if(execute){
                await execute(interaction);
                console.log(`[interaction] ${label} completed OK`);
            }else{
                console.log(`[interaction] ❌ no handler registered for ${label}`);
            }
            return;
        }

        if(interaction.isButton()){
            const handler = buttonHandlers[interaction.customId];
            if(handler){
                await handler(interaction);
                console.log(`[interaction] ${label} completed OK`);
            }else{
                await interaction.reply({ content: "❌ Button not configured.", ephemeral: true }).catch(() => {});
            }
            return;
        }

        if(interaction.isStringSelectMenu()){
            const handler = selectHandlers[interaction.customId];
            if(handler){
                await handler(interaction);
                console.log(`[interaction] ${label} completed OK`);
            }
            return;
        }

        if(interaction.isModalSubmit()){
            const handler = modalHandlers[interaction.customId];
            if(handler){
                await handler(interaction);
                console.log(`[interaction] ${label} completed OK`);
            }
            return;
        }

    }catch(error){

        console.error(`[interaction] ❌ ${label} threw:`, error);

        // Show the *real* error instead of a useless generic message, so you
        // don't have to dig through Railway logs every single time.
        const detail = `\`${error.code ? error.code + ": " : ""}${error.message}\``;

        try{
            if(!interaction.replied && !interaction.deferred){
                await interaction.reply({ content: `❌ Something went wrong: ${detail}`, ephemeral: true });
            }else{
                await interaction.followUp({ content: `❌ Something went wrong: ${detail}`, ephemeral: true });
            }
        }catch(replyErr){
            console.error(`[interaction] ❌ ${label} - even the fallback error reply failed:`, replyErr.message);
        }

    }

});

// ---------------------------------------------------------------------------
// GIVEAWAY END-CHECK LOOP
// ---------------------------------------------------------------------------

client.on("guildMemberAdd", async (member) => {
    try{
        await handleNewMember(member);
    }catch(error){
        console.error("Welcome/autorole handler error:", error);
    }
});

client.on("messageCreate", async (message) => {
    try{
        await handleLeaveVouchMessage(message);
    }catch(error){
        console.error("Leave-vouch handler error:", error);
    }
});

setInterval(async () => {

    const giveaways = giveawaysDB.read();
    let changed = false;

    for(const [messageId, g] of Object.entries(giveaways)){

        if(g.ended || Date.now() < g.endTime) continue;

        g.ended = true;
        changed = true;

        const channel = await client.channels.fetch(g.channelId).catch(() => null);
        if(!channel) continue;

        const winner = g.entries.length
            ? g.entries[Math.floor(Math.random() * g.entries.length)]
            : null;

        const embed = new EmbedBuilder()
            .setColor("#b026ff")
            .setTitle("🎉 GIVEAWAY ENDED")
            .setDescription(
                `🎁 **Prize**\n${g.prize}\n\n` +
                `🏆 **Winner**\n${winner ? `<@${winner}>` : "No valid entries"}\n\n` +
                `👥 **Entries**\n${g.entries.length}`
            )
            .setTimestamp();

        await channel.send({
            content: winner ? `🎊 Congratulations <@${winner}>! You won **${g.prize}**!` : "⚠️ Giveaway ended, no one entered.",
            embeds: [embed]
        });

    }

    if(changed) giveawaysDB.write(giveaways);

}, 10000);

client.login(process.env.TOKEN);
