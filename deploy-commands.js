// deploy-commands.js
// Registers slash commands with Discord. Runs automatically before bot.js
// starts (see package.json "start" script).
//
// If GUILD_ID is set in your env, commands deploy instantly to that one
// server (good for testing). If GUILD_ID is NOT set, commands deploy
// globally (takes up to ~1hr the first time, but works everywhere and
// never breaks due to a stale/wrong guild ID).

require("dotenv").config();

const { REST, Routes } = require("discord.js");
const { slashCommands } = require("./commands");

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

const body = slashCommands.map(c => c.data.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {

    try{

        if(!process.env.TOKEN || !CLIENT_ID){
            console.error("❌ Missing TOKEN or CLIENT_ID in environment — cannot deploy commands.");
            return;
        }

        console.log(`🚀 Deploying ${body.length} slash commands...`);
        console.log(`📌 Client ID: ${CLIENT_ID}`);
        console.log(GUILD_ID ? `📌 Guild ID: ${GUILD_ID} (instant, single-server)` : "📌 Global deploy (can take up to 1hr to appear)");

        const route = GUILD_ID
            ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
            : Routes.applicationCommands(CLIENT_ID);

        await rest.put(route, { body });

        console.log("✅ Slash commands deployed successfully!");

    }catch(error){

        console.error("❌ Command deployment failed:", error.message);

        if(error.code === 50001){
            console.error(
                "\n👉 'Missing Access' usually means the bot's invite link was missing the " +
                "'applications.commands' OAuth2 scope, or GUILD_ID doesn't match a server the " +
                "bot is actually in. Re-invite the bot with:\n" +
                `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands\n`
            );
        }

    }

})();
